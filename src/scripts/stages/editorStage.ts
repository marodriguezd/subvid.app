import { baseFileName } from "@/scripts/file.ts"
import type { Stage } from "@/scripts/stageManager.ts"
import { buildSrt, formatClock } from "@/scripts/subtitles.ts"
import type { ui as appUi } from "@/scripts/ui.ts"

type Segment = { start: number; end: number; text: string }

type EditorStageOptions = {
  ui: typeof appUi
  currentSegments: () => Segment[]
  activeLang: () => string
  selectedVideoFile: () => File | null
  isExporting: () => boolean
  setStage: (stage: Stage) => void
  undo: () => void
  redo: () => void
}

function isTextInputTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable)
  )
}

export function createEditorStageController({
  ui,
  currentSegments,
  activeLang,
  selectedVideoFile,
  isExporting,
  setStage,
  undo,
  redo,
}: EditorStageOptions) {
  function enableExports(on: boolean) {
    const ready = on && currentSegments().length > 0
    ui.downloadSrtBtn.disabled = !ready
    ui.downloadVideoBtn.disabled = !ready
    ui.exportFormat.disabled = !ready
    ui.exportQuality.disabled = !ready
  }

  function backToConfig() {
    if (isExporting()) return
    ui.video.pause()
    setStage("config")
  }

  async function downloadSrt() {
    const segments = currentSegments()
    if (!segments.length) return

    const srtContent = buildSrt(segments)
    const filename = `${baseFileName(selectedVideoFile())}.${activeLang()}.srt`
    const blob = new Blob([srtContent], {
      type: "text/plain;charset=utf-8",
    })

    try {
      if (typeof navigator !== "undefined" && navigator.canShare) {
        const file = new File([blob], filename, { type: "text/plain" })
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({
            files: [file],
            title: filename,
          })
          return
        }
      }
    } catch {}

    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  }

  function handleKeyboardShortcut(event: KeyboardEvent) {
    if (!ui.stageEditor.hidden && ui.exportModal.hidden) {
      const key = event.key.toLowerCase()

      if ((event.metaKey || event.ctrlKey) && (key === "z" || key === "y")) {
        if (isTextInputTarget(event.target)) return

        const wantsRedo = key === "y" || (key === "z" && event.shiftKey)
        event.preventDefault()
        if (wantsRedo) redo()
        else undo()
        return
      }

      if (event.key === " " && !isTextInputTarget(event.target)) {
        event.preventDefault()
        if (ui.video.paused) ui.video.play().catch(() => {})
        else ui.video.pause()
        return
      }

      if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        !isTextInputTarget(event.target)
      ) {
        const duration = ui.video.duration
        if (!Number.isFinite(duration)) return
        event.preventDefault()
        const step = event.shiftKey ? 5 : 1
        const delta = event.key === "ArrowRight" ? step : -step
        ui.video.currentTime = Math.max(
          0,
          Math.min(duration, (ui.video.currentTime || 0) + delta),
        )
      }
    }
  }

  function updateMobileClock() {
    if (ui.mobileClock && ui.video) {
      const cur = formatClock(ui.video.currentTime || 0)
      const dur = formatClock(ui.video.duration || 0)
      ui.mobileClock.textContent = `${cur} / ${dur}`
    }
  }

  function wireEditorStage() {
    ui.backBtn.addEventListener("click", backToConfig)
    ui.undoBtn?.addEventListener("click", undo)
    ui.redoBtn?.addEventListener("click", redo)
    ui.downloadSrtBtn.addEventListener("click", downloadSrt)
    document.addEventListener("keydown", handleKeyboardShortcut)

    // Mobile studio mode switcher (CapCut / OpenCap tabs)
    if (ui.mobileEditorTabs) {
      const tabs = ui.mobileEditorTabs.querySelectorAll<HTMLButtonElement>(".mobile-tab-btn")
      tabs.forEach((btn) => {
        btn.addEventListener("click", () => {
          const tab = btn.dataset.tab
          if (tab && ui.stageEditor) {
            ui.stageEditor.dataset.mobileTab = tab
            tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.tab === tab))
          }
        })
      })
    }

    // Mobile player controls
    ui.mobilePlayBtn?.addEventListener("click", () => {
      if (ui.video.paused) ui.video.play().catch(() => {})
      else ui.video.pause()
    })

    ui.mobileFsBtn?.addEventListener("click", () => {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {})
      } else if (ui.videoPreview?.requestFullscreen) {
        ui.videoPreview.requestFullscreen().catch(() => {})
      } else if ((ui.video as any)?.webkitEnterFullscreen) {
        ;(ui.video as any).webkitEnterFullscreen()
      }
    })

    ui.video.addEventListener("play", () => {
      ui.stageEditor?.classList.add("is-playing")
    })
    ui.video.addEventListener("pause", () => {
      ui.stageEditor?.classList.remove("is-playing")
    })
    ui.video.addEventListener("timeupdate", updateMobileClock)
    ui.video.addEventListener("seeked", updateMobileClock)
    ui.video.addEventListener("loadedmetadata", updateMobileClock)
  }

  return {
    enableExports,
    backToConfig,
    downloadSrt,
    wireEditorStage,
  }
}
