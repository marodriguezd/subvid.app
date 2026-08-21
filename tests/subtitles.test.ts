import { describe, it, expect } from "vitest"
import {
  formatSrtTime,
  formatClock,
  parseClock,
  buildSrt,
  normalizeSegments,
  estimatedWordsForSegment,
  normalizeLanguageCode,
} from "@/scripts/subtitles.ts"
import {
  parseSrt,
  parseVtt,
  contrastSubtitles,
  levenshteinDistance,
  computeWordErrorRate,
} from "./subtitle_diff.ts"
import { GOLDEN_SEGMENTS, GOLDEN_SRT, GOLDEN_VTT } from "./fixtures/generate_demo_assets.ts"

describe("Subtitles & Formatting Suite", () => {
  it("formats SRT timestamps accurately according to SubRip spec", () => {
    expect(formatSrtTime(0)).toBe("00:00:00,000")
    expect(formatSrtTime(1.5)).toBe("00:00:01,500")
    expect(formatSrtTime(65.123)).toBe("00:01:05,123")
    expect(formatSrtTime(3661.045)).toBe("01:01:01,045")
  })

  it("formats and parses clocks correctly", () => {
    expect(formatClock(0)).toBe("0:00.00")
    expect(formatClock(12.34)).toBe("0:12.34")
    expect(formatClock(125.5)).toBe("2:05.50")

    expect(parseClock("0:12.34")).toBeCloseTo(12.34, 2)
    expect(parseClock("2:05.50")).toBeCloseTo(125.5, 2)
    expect(parseClock("invalid")).toBeNull()
  })

  it("normalizes language codes against supported languages", () => {
    expect(normalizeLanguageCode("en")).toBe("en")
    expect(normalizeLanguageCode("es")).toBe("es")
    expect(normalizeLanguageCode("en-US")).toBe("en")
    expect(normalizeLanguageCode("es-ES")).toBe("es")
    expect(normalizeLanguageCode("unknown_xyz")).toBe("")
  })

  it("builds valid SRT string from structured segments", () => {
    const srt = buildSrt(GOLDEN_SEGMENTS)
    expect(srt).toBe(GOLDEN_SRT.trim())
  })

  it("parses SRT content back into structured cues accurately", () => {
    const parsed = parseSrt(GOLDEN_SRT)
    expect(parsed.length).toBe(2)
    expect(parsed[0].start).toBe(0.5)
    expect(parsed[0].end).toBe(2.5)
    expect(parsed[0].text).toBe("Welcome to Subvid subtitle generator.")
    expect(parsed[1].start).toBe(3.2)
    expect(parsed[1].end).toBe(5.5)
    expect(parsed[1].text).toBe("AI-powered subtitles for any video.")
  })

  it("parses WebVTT content back into structured cues accurately", () => {
    const parsed = parseVtt(GOLDEN_VTT)
    expect(parsed.length).toBe(2)
    expect(parsed[0].start).toBe(0.5)
    expect(parsed[0].end).toBe(2.5)
    expect(parsed[0].text).toBe("Welcome to Subvid subtitle generator.")
  })

  it("estimates word-level timings evenly across a segment", () => {
    const segment = {
      start: 0,
      end: 2,
      text: "Hello world testing",
    }
    const words = estimatedWordsForSegment(segment)
    expect(words.length).toBe(3)
    expect(words[0].text).toBe("Hello")
    expect(words[1].text).toBe("world")
    expect(words[2].text).toBe("testing")
    expect(words[0].start).toBe(0)
    expect(words[2].end).toBe(2)
    expect(words[0].end).toBeLessThanOrEqual(words[1].start + 0.01)
  })

  it("empirically contrasts identical subtitles with 100% similarity and 0 drift", () => {
    const goldenCues = parseSrt(GOLDEN_SRT)
    const report = contrastSubtitles(goldenCues, goldenCues)
    expect(report.passed).toBe(true)
    expect(report.textSimilarityPercent).toBe(100)
    expect(report.wordErrorRatePercent).toBe(0)
    expect(report.maxTimestampDriftMs).toBe(0)
    expect(report.errors.length).toBe(0)
  })

  it("detects timestamp drift and word divergences in contrasting", () => {
    const goldenCues = parseSrt(GOLDEN_SRT)
    const divergedCues = [
      { id: 1, start: 0.8, end: 2.5, text: "Welcome to Subvid subtitle generator." },
      { id: 2, start: 3.2, end: 5.5, text: "AI-powered captioning for any video." },
    ]
    const report = contrastSubtitles(goldenCues, divergedCues, 200, 0.95)
    expect(report.passed).toBe(false)
    expect(report.maxTimestampDriftMs).toBe(300) // 0.8 - 0.5 = 300ms
    expect(report.wordErrorRatePercent).toBeGreaterThan(0)
    expect(report.errors.some((e) => e.includes("drift"))).toBe(true)
  })
})
