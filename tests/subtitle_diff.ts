export type ParsedCue = {
  id: number
  start: number
  end: number
  text: string
}

export type SubtitleDiffReport = {
  passed: boolean
  totalExpectedCues: number
  totalActualCues: number
  textSimilarityPercent: number
  wordErrorRatePercent: number
  maxTimestampDriftMs: number
  cues: Array<{
    index: number
    expectedText: string
    actualText: string
    expectedStart: number
    actualStart: number
    expectedEnd: number
    actualEnd: number
    startDiffMs: number
    endDiffMs: number
    textMatch: boolean
  }>
  errors: string[]
}

/**
 * Parses SRT timestamp string "00:01:23,456" to seconds (83.456)
 */
export function parseSrtTimestamp(ts: string): number {
  const match = ts.trim().match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/)
  if (!match) return 0
  const hours = parseInt(match[1], 10)
  const minutes = parseInt(match[2], 10)
  const seconds = parseInt(match[3], 10)
  const milliseconds = parseInt(match[4], 10)
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000
}

/**
 * Parses an SRT formatted string into an array of structured subtitle cues
 */
export function parseSrt(srtContent: string): ParsedCue[] {
  const normalized = srtContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
  if (!normalized) return []

  const blocks = normalized.split(/\n\n+/)
  const cues: ParsedCue[] = []

  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean)
    if (lines.length < 2) continue

    let id = 0
    let timeLine = ""
    let textLines: string[] = []

    if (lines[0].includes("-->")) {
      id = cues.length + 1
      timeLine = lines[0]
      textLines = lines.slice(1)
    } else {
      id = parseInt(lines[0], 10) || cues.length + 1
      timeLine = lines[1]
      textLines = lines.slice(2)
    }

    const timeParts = timeLine.split("-->")
    if (timeParts.length !== 2) continue

    const start = parseSrtTimestamp(timeParts[0])
    const end = parseSrtTimestamp(timeParts[1])
    const text = textLines.join(" ").trim()

    cues.push({ id, start, end, text })
  }

  return cues
}

/**
 * Parses a WebVTT formatted string into an array of structured subtitle cues
 */
export function parseVtt(vttContent: string): ParsedCue[] {
  const normalized = vttContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
  const lines = normalized.split("\n")
  const cues: ParsedCue[] = []

  let i = 0
  if (lines[0]?.startsWith("WEBVTT")) {
    i = 1
  }

  let currentText: string[] = []
  let currentStart = 0
  let currentEnd = 0
  let currentId = 1

  while (i < lines.length) {
    const line = lines[i].trim()
    if (!line) {
      if (currentText.length > 0) {
        cues.push({
          id: currentId++,
          start: currentStart,
          end: currentEnd,
          text: currentText.join(" ").trim(),
        })
        currentText = []
      }
      i++
      continue
    }

    if (line.includes("-->")) {
      const parts = line.split("-->")
      currentStart = parseSrtTimestamp(parts[0])
      currentEnd = parseSrtTimestamp(parts[1])
    } else if (Number.isInteger(Number(line)) && lines[i + 1]?.includes("-->")) {
      currentId = parseInt(line, 10)
    } else {
      currentText.push(line)
    }
    i++
  }

  if (currentText.length > 0) {
    cues.push({
      id: currentId,
      start: currentStart,
      end: currentEnd,
      text: currentText.join(" ").trim(),
    })
  }

  return cues
}

/**
 * Calculates Levenshtein distance between two strings
 */
export function levenshteinDistance(s1: string, s2: string): number {
  const a = s1.toLowerCase().trim()
  const b = s2.toLowerCase().trim()
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1]
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
      }
    }
  }

  return dp[m][n]
}

/**
 * Computes Word Error Rate (WER) between reference and hypothesis
 */
export function computeWordErrorRate(reference: string, hypothesis: string): number {
  const refWords = reference.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean)
  const hypWords = hypothesis.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean)

  if (refWords.length === 0) return hypWords.length === 0 ? 0 : 1

  const m = refWords.length
  const n = hypWords.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (refWords[i - 1] === hypWords[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1]
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
      }
    }
  }

  return dp[m][n] / m
}

/**
 * Contrasts and empirically verifies generated subtitle cues against golden references
 */
export function contrastSubtitles(
  goldenCues: ParsedCue[],
  actualCues: ParsedCue[],
  maxAllowedDriftMs = 500,
  minAllowedSimilarity = 0.85,
): SubtitleDiffReport {
  const errors: string[] = []
  let maxDriftMs = 0
  const cueReports = []

  const totalExpected = goldenCues.length
  const totalActual = actualCues.length

  if (totalExpected !== totalActual) {
    errors.push(`Segment count mismatch: expected ${totalExpected}, got ${totalActual}`)
  }

  const pairsToCompare = Math.max(totalExpected, totalActual)
  let totalRefWords = 0
  let totalRefLevenshtein = 0

  for (let i = 0; i < pairsToCompare; i++) {
    const expected = goldenCues[i] || { id: i + 1, start: 0, end: 0, text: "" }
    const actual = actualCues[i] || { id: i + 1, start: 0, end: 0, text: "" }

    const startDiffMs = Math.round(Math.abs(expected.start - actual.start) * 1000)
    const endDiffMs = Math.round(Math.abs(expected.end - actual.end) * 1000)
    maxDriftMs = Math.max(maxDriftMs, startDiffMs, endDiffMs)

    if (startDiffMs > maxAllowedDriftMs) {
      errors.push(`Cue #${i + 1} start timestamp drift ${startDiffMs}ms exceeds tolerance ${maxAllowedDriftMs}ms`)
    }
    if (endDiffMs > maxAllowedDriftMs) {
      errors.push(`Cue #${i + 1} end timestamp drift ${endDiffMs}ms exceeds tolerance ${maxAllowedDriftMs}ms`)
    }

    const dist = levenshteinDistance(expected.text, actual.text)
    const maxLen = Math.max(expected.text.length, actual.text.length, 1)
    const sim = 1 - dist / maxLen

    if (sim < minAllowedSimilarity) {
      errors.push(`Cue #${i + 1} text similarity ${Math.round(sim * 100)}% is below threshold ${Math.round(minAllowedSimilarity * 100)}%`)
    }

    totalRefLevenshtein += dist
    totalRefWords += expected.text.length

    cueReports.push({
      index: i + 1,
      expectedText: expected.text,
      actualText: actual.text,
      expectedStart: expected.start,
      actualStart: actual.start,
      expectedEnd: expected.end,
      actualEnd: actual.end,
      startDiffMs,
      endDiffMs,
      textMatch: expected.text.trim().toLowerCase() === actual.text.trim().toLowerCase(),
    })
  }

  const allExpectedText = goldenCues.map((c) => c.text).join(" ")
  const allActualText = actualCues.map((c) => c.text).join(" ")
  const wer = computeWordErrorRate(allExpectedText, allActualText)
  const avgSimilarity = 1 - (totalRefLevenshtein / Math.max(1, totalRefWords))

  return {
    passed: errors.length === 0,
    totalExpectedCues: totalExpected,
    totalActualCues: totalActual,
    textSimilarityPercent: Math.max(0, Math.min(100, Math.round(avgSimilarity * 100))),
    wordErrorRatePercent: Math.round(wer * 100),
    maxTimestampDriftMs: maxDriftMs,
    cues: cueReports,
    errors,
  }
}
