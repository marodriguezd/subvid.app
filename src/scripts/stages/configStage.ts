import { prettifyBytes } from "@/scripts/file.ts"
import { ASR_MODEL, CANARY_API_URL, CANARY_LANGS, LANGS } from "@/scripts/languages.ts"
import { createAudioService } from "@/scripts/media/audio.ts"
import type { Stage } from "@/scripts/stageManager.ts"
import {
  normalizeLanguageCode,
  normalizeSegments,
} from "@/scripts/subtitles.ts"
import type { ui as appUi } from "@/scripts/ui.ts"

type Segment = { start: number; end: number; text: string }
type SegmentsByLang = Record<string, Segment[]>

type GeneratedState = {
  detectedLang: string
  baseSegments: Segment[]
  segmentsByLang: SegmentsByLang
  orderedLangs: string[]
  activeLang: string
  dualTrackMode: boolean
  dualTrackLangs: string[]
}

type AudioJobResult = {
  audio: Float32Array
  audioSeconds: number
}

type AudioJob = {
  key: string
  promise: Promise<AudioJobResult>
  result?: AudioJobResult
  error?: unknown
}

type TranscriptionRequest = {
  file: File
  language: string
  wordTimestamps: boolean
}

type TranscriptionJobResult = {
  output: any
  audio: Float32Array
  audioSeconds: number
  chunksDone: number
}

type TranscriptionJob = {
  key: string
  fileKey: string
  request: TranscriptionRequest
  promise: Promise<TranscriptionJobResult>
  result?: TranscriptionJobResult
  error?: unknown
  settled: boolean
}

type ConfigStageOptions = {
  ui: typeof appUi
  tt: (path: string, vars?: Record<string, unknown>) => string
  downloads: any
  fetchWithProgress: (
    url: string,
    key: string,
    mimeType: string,
    fallbackTotal?: number,
  ) => Promise<string>
  updateDownloadStatus: (key: string, state: string) => void
  transformersClient: any
  translateSegments: (
    segments: Segment[],
    sourceLang: string,
    targetLang: string,
  ) => Promise<Segment[]>
  selectedVideoFile: () => File | null
  isExporting: () => boolean
  setGeneratedState: (state: GeneratedState) => void
  renderTabs: () => void
  renderSegments: () => void
  enableExports: (on: boolean) => void
  resetHistory: () => void
  updateCaption: () => void
  setStage: (stage: Stage) => void
  canaryApiUrl: string
}

const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator

export function createConfigStageController({
  ui,
  tt,
  downloads,
  fetchWithProgress,
  updateDownloadStatus,
  transformersClient,
  translateSegments,
  selectedVideoFile,
  isExporting,
  setGeneratedState,
  renderTabs,
  renderSegments,
  enableExports,
  resetHistory,
  updateCaption,
  setStage,
  canaryApiUrl,
}: ConfigStageOptions) {
  let asrReady = false
  let asrReadyPromise: Promise<void> | null = null
  let progressRaf = 0
  let progressIndeterminate = false
  let activeFileKey = ""
  let audioJob: AudioJob | null = null
  let audioProgressJobKey: string | null = null
  let progressOwnerKey: string | null = null
  let transcriptionQueue = Promise.resolve()
  const transcriptionJobs = new Map<string, TranscriptionJob>()

  function setStatus(message: string, kind = "ok") {
    ui.configStatus.textContent = message
    ui.configStatus.dataset.kind = kind
  }

  function setProgress(percent: number) {
    setIndeterminate(false)
    applyProgress(percent)
  }

  function setIndeterminate(on: boolean) {
    if (on) stopProgressCreep()
    progressIndeterminate = on
    ui.configProgressFill.classList.toggle("is-indeterminate", on)
    if (ui.configProgressTrack) {
      ui.configProgressTrack.setAttribute("aria-busy", on ? "true" : "false")
      if (on) ui.configProgressTrack.removeAttribute("aria-valuenow")
    }
    if (on) ui.configProgressPct.textContent = ""
  }

  function applyProgress(percent: number) {
    if (progressIndeterminate) return
    const clamped = Math.max(0, Math.min(100, percent))
    const rounded = Math.round(clamped)
    ui.configProgressFill.style.width = `${clamped}%`
    ui.configProgressPct.textContent = `${rounded}%`
    ui.configProgressTrack?.setAttribute("aria-valuenow", String(rounded))
  }

  function stopProgressCreep() {
    if (progressRaf) {
      cancelAnimationFrame(progressRaf)
      progressRaf = 0
    }
  }

  function startProgressCreep(from: number, ceiling: number, expected: number) {
    stopProgressCreep()
    const start = performance.now()
    const span = ceiling - from
    const tick = (now: number) => {
      const t = (now - start) / Math.max(1, expected)
      const eased = 1 - Math.exp(-1.6 * t)
      applyProgress(from + span * eased)
      progressRaf = requestAnimationFrame(tick)
    }
    progressRaf = requestAnimationFrame(tick)
  }

  function fileKey(file: File) {
    return [file.name, file.size, file.lastModified, file.type || "video"].join(":")
  }

  function selectedFileKey() {
    const file = selectedVideoFile()
    return file ? fileKey(file) : ""
  }

  function ensureFileSession(file: File) {
    const key = fileKey(file)
    if (activeFileKey !== key) {
      resetTranscriptionCache()
      activeFileKey = key
    }
    return key
  }

  function transcriptionKey(request: TranscriptionRequest) {
    const language = request.language || "auto"
    const detail = request.wordTimestamps ? "words" : "segments"
    return `${fileKey(request.file)}:${language}:${detail}`
  }

  function canUpdateJobProgress(jobKey: string | null) {
    return !!jobKey && jobKey === progressOwnerKey && activeFileKey === selectedFileKey()
  }

  function withAudioProgress(jobKey: string, run: () => Promise<AudioJobResult>) {
    audioProgressJobKey = jobKey
    return run().finally(() => {
      if (audioProgressJobKey === jobKey) audioProgressJobKey = null
    })
  }

  const { ensureFfmpeg, extractAudioBuffer, remuxAudioToAacLc } = createAudioService({
    tt,
    fetchWithProgress,
    updateDownloadStatus,
    setStatus: (message, kind) => {
      if (canUpdateJobProgress(audioProgressJobKey)) setStatus(message, kind)
    },
    setProgress: (percent) => {
      if (canUpdateJobProgress(audioProgressJobKey)) setProgress(percent)
    },
    applyProgress: (percent) => {
      if (canUpdateJobProgress(audioProgressJobKey)) applyProgress(percent)
    },
    setIndeterminate: (on) => {
      if (canUpdateJobProgress(audioProgressJobKey)) setIndeterminate(on)
    },
    startProgressCreep: (from, ceiling, expected) => {
      if (canUpdateJobProgress(audioProgressJobKey))
        startProgressCreep(from, ceiling, expected)
    },
    stopProgressCreep: () => {
      if (canUpdateJobProgress(audioProgressJobKey)) stopProgressCreep()
    },
  })

  function logGeneration(event: string, details: Record<string, unknown> = {}) {
    console.info(`[generate] ${event}`, details)
  }

  function formatElapsed(ms: number) {
    const totalSeconds = Math.max(0, Math.round(ms / 1000))
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`
    if (minutes) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
    return `${seconds}s`
  }

  function outputTarget(sourceLang: string) {
    const value = ui.outputLang.value
    if (!value || value === "same") return sourceLang
    const available = useCanaryApi ? CANARY_LANGS : LANGS
    return value in available ? value : sourceLang
  }

  function canEnableDualTrackOption() {
    const target = ui.outputLang.value
    return !ui.inputLang.value && !!target && target !== "same"
  }

  function syncDualTrackOption() {
    const available = canEnableDualTrackOption() && !useCanaryApi
    ui.dualTrackField.hidden = !available
    ui.dualTrack.disabled = !available
    if (!available) ui.dualTrack.checked = false
  }

  const useCanaryApi = !!canaryApiUrl

  async function ensureRecognizer() {
    if (useCanaryApi) return
    if (asrReady) return
    if (!asrReadyPromise) {
      asrReadyPromise = (async () => {
        updateDownloadStatus("asr", "downloading")
        await transformersClient.call("ensure-asr", {
          model: ASR_MODEL,
          webgpu: hasWebGPU,
        })
        asrReady = true
        updateDownloadStatus("asr", "ready")
      })().finally(() => {
        asrReadyPromise = null
      })
    }
    await asrReadyPromise
  }

  async function preloadAssetsInBackground() {
    const tasks: Promise<any>[] = [
      ensureFfmpeg().catch((error) => {
        console.error(error)
        updateDownloadStatus("ffmpeg", "error")
      }),
    ]
    if (!useCanaryApi) {
      tasks.push(
        ensureRecognizer().catch((error) => {
          console.error(error)
          updateDownloadStatus("asr", "error")
        }),
      )
    }
    await Promise.allSettled(tasks)
  }

  function requestFromCurrentOptions(file: File): TranscriptionRequest {
    return {
      file,
      language: ui.inputLang.value || "",
      wordTimestamps: true,
    }
  }

  function takeProgressOwnership(job: TranscriptionJob) {
    progressOwnerKey = job.key
    ui.configProgress.hidden = false
    setIndeterminate(false)
  }

  function getAudioJob(file: File, jobKey: string) {
    const key = fileKey(file)
    if (audioJob?.key === key && !audioJob.error) return audioJob

    const job: AudioJob = {
      key,
      promise: withAudioProgress(jobKey, async () => {
        const extractStartedAt = performance.now()
        const audio = await extractAudioBuffer(file)
        const audioSeconds = audio.length / 16000
        logGeneration("audio:ready", {
          audioSeconds: Math.round(audioSeconds),
          samples: audio.length,
          elapsedMs: Math.round(performance.now() - extractStartedAt),
        })
        return { audio, audioSeconds }
      }),
    }

    job.promise.then(
      (result) => {
        job.result = result
      },
      (error) => {
        job.error = error
      },
    )
    audioJob = job
    return job
  }

  async function runTranscriptionJob(
    job: TranscriptionJob,
  ): Promise<TranscriptionJobResult> {
    const { file, language, wordTimestamps } = job.request
    const { audio, audioSeconds } = await getAudioJob(file, job.key).promise

    if (canUpdateJobProgress(job.key)) {
      setStatus(tt("steps.loadingSpeech"), "busy")
      startProgressCreep(38, 48, 8000)
    }

    const asrMonitor = setInterval(() => {
      if (!canUpdateJobProgress(job.key)) return
      const download = downloads.asr
      if (download.state === "downloading" && download.total) {
        stopProgressCreep()
        const ratio = Math.min(1, download.progress / 100)
        applyProgress(38 + ratio * 10)
        const meta =
          prettifyBytes(download.loaded) + " / " + prettifyBytes(download.total)
        setStatus(`Step 4/5 · Downloading speech model… ${meta}`, "busy")
      }
    }, 200)

    try {
      const recognizerStartedAt = performance.now()
      const cached = asrReady
      logGeneration("recognizer:start", { cached })
      await ensureRecognizer()
      logGeneration("recognizer:ready", {
        cached,
        elapsedMs: Math.round(performance.now() - recognizerStartedAt),
      })
    } finally {
      clearInterval(asrMonitor)
      if (canUpdateJobProgress(job.key)) {
        stopProgressCreep()
        setProgress(48)
      }
    }

    const TR_START = 48
    const TR_END = 90
    const chunkSeconds = 30 - 2 * 5
    const totalChunks = Math.max(1, Math.ceil(audioSeconds / chunkSeconds))
    const chunkSpan = (TR_END - TR_START) / totalChunks
    let chunksDone = 0
    let lastChunkAt = performance.now()
    let perChunkMs = Math.max(2000, (audioSeconds / totalChunks) * 900)

    const transcribeStatus = () => {
      setStatus(tt("steps.transcribing"), "busy")
    }

    if (canUpdateJobProgress(job.key)) {
      transcribeStatus()
      applyProgress(TR_START)
      startProgressCreep(TR_START, TR_START + chunkSpan, perChunkMs)
    }

    const transcribeStartedAt = performance.now()
    logGeneration("transcription:start", {
      audioSeconds: Math.round(audioSeconds),
      estimatedChunks: totalChunks,
      language: language || "auto",
      wordTimestamps,
    })

    transformersClient.setChunkHandler(() => {
      const now = performance.now()
      perChunkMs = Math.max(500, now - lastChunkAt)
      lastChunkAt = now
      chunksDone = Math.min(totalChunks, chunksDone + 1)
      const floor = Math.min(TR_END, TR_START + chunksDone * chunkSpan)
      const ceiling = Math.min(TR_END, floor + chunkSpan)

      if (canUpdateJobProgress(job.key)) {
        transcribeStatus()
        stopProgressCreep()
        applyProgress(floor)
        if (chunksDone < totalChunks)
          startProgressCreep(floor, ceiling, perChunkMs)
      }

      logGeneration("transcription:chunk", {
        chunk: chunksDone,
        estimatedChunks: totalChunks,
        elapsedMs: Math.round(now - transcribeStartedAt),
      })
    })

    try {
      const audioForWorker = audio.slice()
      const output = await transformersClient.call(
        "transcribe",
        {
          audio: audioForWorker,
          language: language || null,
          wordTimestamps,
        },
        [audioForWorker.buffer],
      )
      logGeneration("transcription:done", {
        chunks: chunksDone,
        elapsedMs: Math.round(performance.now() - transcribeStartedAt),
      })
      if (canUpdateJobProgress(job.key)) {
        stopProgressCreep()
        setProgress(TR_END)
      }
      return { output, audio, audioSeconds, chunksDone }
    } finally {
      transformersClient.setChunkHandler(null)
    }
  }

  function getOrCreateTranscriptionJob(request: TranscriptionRequest) {
    const fileKeyValue = ensureFileSession(request.file)
    const key = transcriptionKey(request)
    const existing = transcriptionJobs.get(key)
    if (existing && !existing.error) return existing
    if (existing?.error) transcriptionJobs.delete(key)

    const job = {
      key,
      fileKey: fileKeyValue,
      request,
      settled: false,
    } as TranscriptionJob

    const runner = useCanaryApi ? runCanaryTranscriptionJob : runTranscriptionJob
    job.promise = transcriptionQueue
      .then(() => runner(job))
      .then(
        (result) => {
          job.result = result
          return result
        },
        (error) => {
          job.error = error
          throw error
        },
      )
      .finally(() => {
        job.settled = true
      })

    transcriptionQueue = job.promise.catch(() => {})
    transcriptionJobs.set(key, job)
    return job
  }

  async function runCanaryTranscriptionJob(
    job: TranscriptionJob,
  ): Promise<TranscriptionJobResult> {
    const { file, language, wordTimestamps } = job.request

    const sourceLang = language || "en"
    const target = outputTarget(sourceLang)

    if (canUpdateJobProgress(job.key)) {
      setStatus("Uploading audio to Canary server…", "busy")
      setProgress(2)
      setIndeterminate(true)
    }

    logGeneration("canary:start", {
      fileName: file.name,
      fileSize: file.size,
      sourceLang,
      targetLang: target,
      wordTimestamps,
    })

    // Kick off audio extraction in parallel with the upload/SSE so we can
    // refine Canary's word-level timestamps (proportionally distributed by
    // the backend) against actual speech edges via the frontend's VAD.
    // Failure is non-fatal — an empty buffer falls back to the old behavior
    // (no refinement, but the word-split backend pipeline still kicks in).
    const audioRefinementPromise = extractAudioBuffer(file).catch((error) => {
      console.warn(
        "[generate] audio extraction for subtitle refinement failed",
        error,
      )
      return new Float32Array(0)
    })

    // Build FormData
    const formData = new FormData()
    formData.append("file", file)
    formData.append("source_lang", sourceLang)
    formData.append("target_lang", target)
    formData.append("word_timestamps", wordTimestamps ? "true" : "false")
    formData.append("pnc", "true")

    const uploadStart = performance.now()

    try {
      // Step 1: POST the file, get job_id + stream_url
      const startResponse = await fetch(`${canaryApiUrl}/api/transcribe/stream`, {
        method: "POST",
        body: formData,
      })

      if (!startResponse.ok) {
        const errorText = await startResponse.text().catch(() => "Unknown error")
        throw new Error(`Canary API error (${startResponse.status}): ${errorText}`)
      }

      const { job_id, stream_url } = await startResponse.json()
      logGeneration("canary:uploaded", {
        jobId: job_id,
        elapsedMs: Math.round(performance.now() - uploadStart),
      })

      if (canUpdateJobProgress(job.key)) {
        setIndeterminate(false)
        setProgress(8)
        setStatus("Waiting for Canary server…", "busy")
      }

      // Step 2: Open SSE stream for progress events
      const result = await new Promise<any>((resolve, reject) => {
        // Resolve stream_url relative to canaryApiUrl (handles trailing slashes)
        const streamFullUrl = new URL(stream_url, canaryApiUrl).href

        const eventSource = new EventSource(streamFullUrl)
        let chunksDone = 0
        let totalChunks = 0
        let audioSeconds = 60
        let lastProgress = 10
        let settled = false
        const transcribeStart = performance.now()

        // Timeout after 15 minutes
        const timeoutId = setTimeout(() => {
          fail(new Error("Transcription timed out after 15 minutes. Try a shorter file."))
        }, 900_000)

        const finish = (result: any) => {
          if (settled) return
          settled = true
          clearTimeout(timeoutId)
          eventSource.close()
          resolve(result)
        }

        const fail = (error: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timeoutId)
          eventSource.close()
          reject(error)
        }

        eventSource.addEventListener("progress", (event: MessageEvent) => {
          try {
            const data = JSON.parse(event.data)
            chunksDone = data.chunks_done || 0
            totalChunks = data.total_chunks || 0
            const pct = data.progress || 0

            if (canUpdateJobProgress(job.key)) {
              setIndeterminate(false)
              setProgress(pct)
              setStatus(data.message || tt("steps.transcribing"), "busy")

              // Smooth animation between SSE events
              const nextPct = totalChunks > 0
                ? 20 + Math.floor(70 * (chunksDone + 1) / totalChunks)
                : Math.min(pct + 5, 90)
              if (pct < 90 && pct > lastProgress) {
                startProgressCreep(pct, nextPct,
                  totalChunks > 0 ? 5000 : 10000)
              }
              lastProgress = pct

              if (totalChunks > 0 && chunksDone > 0 && chunksDone < totalChunks) {
                logGeneration("canary:chunk", {
                  chunk: chunksDone,
                  totalChunks,
                  elapsedMs: Math.round(performance.now() - transcribeStart),
                })
              }
            }
          } catch { /* ignore parse errors */ }
        })

        eventSource.addEventListener("result", (event: MessageEvent) => {
          try {
            const data = JSON.parse(event.data)
            const output = data.result
            if (!output) {
              fail(new Error("No result in SSE event"))
              return
            }

            const lastChunk = output.chunks?.[output.chunks.length - 1]
            audioSeconds = lastChunk?.timestamp?.[1] || 60

            logGeneration("canary:done", {
              chunks: chunksDone,
              totalChunks,
              segments: output.chunks?.length || 0,
              elapsedMs: Math.round(performance.now() - transcribeStart),
              totalElapsedMs: Math.round(performance.now() - uploadStart),
            })

            if (canUpdateJobProgress(job.key)) {
              stopProgressCreep()
              setProgress(90)
            }

            // Resolve with a Promise so the outer await unwraps both the SSE
            // result AND the parallel audio extraction. Use the actual audio
            // buffer length for `audioSeconds` (the last-chunk-end heuristic
            // underestimates because Canary returns word-level chunks now).
            resolve(
              audioRefinementPromise.then((audioBuffer) => ({
                output,
                audio: audioBuffer,
                audioSeconds: audioBuffer.length
                  ? audioBuffer.length / 16000
                  : audioSeconds,
                chunksDone,
              })),
            )
          } catch (e) {
            fail(e instanceof Error ? e : new Error(String(e)))
          }
        })

        // Named "failure" event from backend (avoids EventSource.onerror conflict)
        eventSource.addEventListener("failure", (event: MessageEvent) => {
          let errorMsg = "Transcription failed on server"
          try {
            const data = JSON.parse(event.data)
            errorMsg = data.error || data.message || errorMsg
          } catch { /* use default */ }
          fail(new Error(errorMsg))
        })

      })

      return result
    } catch (error: any) {
      if (error.name === "AbortError") {
        throw new Error("Transcription timed out. Try a shorter file.")
      }
      throw error
    }
  }

  function resetTranscriptionCache() {
    activeFileKey = ""
    audioJob = null
    audioProgressJobKey = null
    progressOwnerKey = null
    transcriptionJobs.clear()
    transformersClient.setChunkHandler(null)
    stopProgressCreep()
    setIndeterminate(false)
  }

  function startEarlyTranscription(file = selectedVideoFile()) {
    if (!file || isExporting()) return
    ensureFileSession(file)
    const job = getOrCreateTranscriptionJob({
      file,
      language: "",
      wordTimestamps: true,
    })
    takeProgressOwnership(job)
    if (!job.result) {
      setStatus(tt("steps.preparing"), "busy")
      setProgress(2)
    }
    job.promise
      .then(() => {
        if (!canUpdateJobProgress(job.key)) return
        setStatus(tt("transcriptionReady"), "ok")
        ui.configProgress.hidden = true
      })
      .catch((error) => {
        console.warn("[generate] early transcription failed", error)
        if (!canUpdateJobProgress(job.key)) return
        setStatus(tt("videoLoaded"), "ok")
        setProgress(0)
        ui.configProgress.hidden = true
      })
  }

  async function generate() {
    const file = selectedVideoFile()
    if (!file || isExporting()) return

    ui.transcribeBtn.disabled = true
    ui.downloadVideoBtn.disabled = true
    ui.downloadSrtBtn.disabled = true
    ui.configError.hidden = true
    ui.configError.textContent = ""
    ui.generationTime.hidden = true
    ui.generationTime.textContent = ""
    const request = requestFromCurrentOptions(file)
    const job = getOrCreateTranscriptionJob(request)
    const hadVisibleProgress =
      progressOwnerKey === job.key && !ui.configProgress.hidden
    takeProgressOwnership(job)
    if (!job.result && !hadVisibleProgress) {
      setStatus(tt("steps.preparing"), "busy")
      setProgress(2)
    }
    const generationStartedAt = performance.now()
    logGeneration("start", {
      fileSize: file.size,
      fileType: file.type || "unknown",
      inputLang: ui.inputLang.value || "auto",
      outputLang: ui.outputLang.value || "same",
      wordAnimation: ui.wordAnimation.checked,
      webgpu: hasWebGPU,
      canaryApi: useCanaryApi,
    })

    try {
      const reusedTranscription = !!job.result
      if (reusedTranscription) {
        logGeneration("transcription:cache-hit", {
          language: request.language || "auto",
          wordTimestamps: request.wordTimestamps,
        })
      }
      const { output, audio, chunksDone } = await job.promise
      logGeneration("transcription:available", {
        cached: reusedTranscription,
        chunks: chunksDone,
        totalElapsedMs: Math.round(performance.now() - generationStartedAt),
      })

      stopProgressCreep()
      setProgress(90)
      setStatus(tt("steps.buildingLines"), "busy")
      applyProgress(92)

      const normalizeStartedAt = performance.now()
      const detectedLang =
        normalizeLanguageCode(output?.language) ||
        normalizeLanguageCode(ui.inputLang.value) ||
        "en"

      // Both the Canary API path and the local Whisper path use normalizeSegments
      // for display-quality processing:
      //   • aspect-ratio-aware line limits (max chars/words per subtitle,
      //     shorter lines on portrait videos so text doesn't overflow)
      //   • minimum 0.35s duration per segment (avoids flash-disappearing
      //     subtitles for very short chunks)
      //   • overlap resolution between consecutive segments
      //   • merges gaps < 0.06s between speech runs
      //   • refines start/end against actual speech edges when `audio` is
      //     non-empty (energy-based VAD from the WAV buffer)
      // Whisper's local path feeds the extracted Float32Array → full refinement.
      // Canary currently sends an empty audio buffer → speech-run refinement is
      // a no-op there, but the duration/overlap/line-limit fixes still apply.
      const vw = ui.configVideo?.videoWidth || ui.video?.videoWidth || 0
      const vh = ui.configVideo?.videoHeight || ui.video?.videoHeight || 0
      const aspectRatio = vw && vh ? vw / vh : 16 / 9
      let baseSegments: Segment[] = normalizeSegments(output, {
        audio,
        sampleRate: 16_000,
        aspectRatio,
      })

      // Fallback: if the model returned text but no usable chunks (very rare),
      // build a single segment so the user still sees something in the editor.
      if (!baseSegments.length && output.text?.trim()) {
        baseSegments = [{ start: 0, end: 6, text: output.text.trim() }]
      }

      // Note: when using Canary API, the output already contains the target
      // language transcription. Canary handles translation natively
      // (source_lang → target_lang), so we don't need client-side NLLB/MarianMT.

      logGeneration("segments:ready", {
        detectedLang,
        segments: baseSegments.length,
        canaryTranslation: useCanaryApi,
        elapsedMs: Math.round(performance.now() - normalizeStartedAt),
        totalElapsedMs: Math.round(performance.now() - generationStartedAt),
      })

      if (!baseSegments.length) throw new Error(tt("noSpeech"))

      const target = outputTarget(detectedLang)
      const targets = [detectedLang]

      // When using Canary API with self-translation, the output is already in target language.
      // We only need to set up the single target language track.
      if (useCanaryApi && target !== detectedLang) {
        // Canary already translated from detectedLang → target.
        // Set target as the primary output, keeping detectedLang as the source.
        // For dual-track, Canary would need a second API call (not implemented yet).
        setProgress(94)
      } else if (!useCanaryApi) {
        if (target !== detectedLang && !targets.includes(target))
          targets.push(target)
      }

      const dualTrackMode =
        useCanaryApi
          ? false // Canary single-call mode doesn't support dual track
          : ui.dualTrack.checked &&
            !ui.inputLang.value &&
            target !== detectedLang &&
            targets.includes(target)

      const TX_START = 92
      const TX_SPAN = 100 - TX_START
      const segmentsByLang: SegmentsByLang = {}
      let done = 0

      if (useCanaryApi) {
        // Canary already produced the target language output.
        // The output language from the API is the target_lang we requested.
        // Note: dual-track mode is not supported in single-call Canary mode.
        const outputLang = target
        segmentsByLang[outputLang] = baseSegments.map((s) => ({ ...s }))
        done = 1
        setProgress(TX_START + TX_SPAN)
      } else {
        for (const lang of targets) {
          if (lang === detectedLang) {
            segmentsByLang[lang] = baseSegments.map((segment) => ({ ...segment }))
          } else {
            const translationStartedAt = performance.now()
            logGeneration("translation:start", {
              sourceLang: detectedLang,
              targetLang: lang,
              segments: baseSegments.length,
            })
            startProgressCreep(
              TX_START + (done / targets.length) * TX_SPAN,
              Math.min(99, TX_START + ((done + 1) / targets.length) * TX_SPAN),
              6000,
            )
            segmentsByLang[lang] = await translateSegments(
              baseSegments,
              detectedLang,
              lang,
            )
            stopProgressCreep()
            logGeneration("translation:done", {
              sourceLang: detectedLang,
              targetLang: lang,
              elapsedMs: Math.round(performance.now() - translationStartedAt),
              totalElapsedMs: Math.round(performance.now() - generationStartedAt),
            })
          }
          done += 1
          setProgress(TX_START + (done / targets.length) * TX_SPAN)
        }
      }

      setGeneratedState({
        detectedLang,
        baseSegments,
        segmentsByLang,
        orderedLangs: useCanaryApi ? [target] : targets,
        activeLang: target,
        dualTrackMode,
        dualTrackLangs: dualTrackMode ? [detectedLang, target] : [],
      })
      renderTabs()
      renderSegments()
      enableExports(true)
      ui.addSegBtn.disabled = false
      resetHistory()
      const totalElapsedMs = Math.round(performance.now() - generationStartedAt)
      ui.generationTime.textContent = tt("generatedIn", {
        time: formatElapsed(totalElapsedMs),
      })
      ui.generationTime.hidden = false
      setProgress(100)
      setStatus(
        tt("ready", { n: baseSegments.length, count: targets.length }),
        "ok",
      )
      setStage("editor")
      updateCaption()
      ui.configProgress.hidden = true
      logGeneration("done", {
        totalElapsedMs,
        segments: baseSegments.length,
        tracks: useCanaryApi ? 1 : targets.length,
      })
    } catch (error: any) {
      console.error(error)
      console.warn("[generate] failed", {
        elapsedMs: Math.round(performance.now() - generationStartedAt),
        error,
      })
      const message = error?.message || tt("genError")
      setStatus(message, "error")
      setProgress(0)
      ui.configError.textContent = message
      ui.configError.hidden = false
      ui.configProgress.hidden = true
    } finally {
      ui.transcribeBtn.disabled = false
    }
  }

  function wireConfigStage() {
    ui.transcribeBtn.addEventListener("click", generate)
    ui.inputLang.addEventListener("change", syncDualTrackOption)
    ui.outputLang.addEventListener("change", syncDualTrackOption)
    syncDualTrackOption()
  }

  return {
    setStatus,
    setProgress,
    applyProgress,
    setIndeterminate,
    startProgressCreep,
    stopProgressCreep,
    ensureRecognizer,
    preloadAssetsInBackground,
    startEarlyTranscription,
    resetTranscriptionCache,
    generate,
    wireConfigStage,
    remuxAudioToAacLc,
  }
}
