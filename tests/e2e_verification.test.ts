import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildSrt, normalizeSegments } from "@/scripts/subtitles.ts"
import { parseSrt, parseVtt, contrastSubtitles } from "./subtitle_diff.ts"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

describe("Empirical End-to-End Subtitle Extraction & Golden Verification Suite", () => {
  const fixturesDir = path.join(__dirname, "fixtures")
  const outDir = path.join(__dirname, "..", "build-outputs", "test-results")

  it("extracts, formats, and empirically matches the golden SRT file", () => {
    // 1. Load ground truth golden subtitle
    const goldenSrtPath = path.join(fixturesDir, "demo_speech.golden.srt")
    expect(fs.existsSync(goldenSrtPath)).toBe(true)
    const goldenSrtContent = fs.readFileSync(goldenSrtPath, "utf-8")
    const goldenCues = parseSrt(goldenSrtContent)

    expect(goldenCues.length).toBeGreaterThan(0)

    // 2. Simulate model ASR output chunks from demo_speech audio
    const rawAsrOutput = {
      text: "Welcome to Subvid subtitle generator. AI-powered subtitles for any video.",
      chunks: [
        {
          timestamp: [0.5, 2.5],
          text: "Welcome to Subvid subtitle generator.",
        },
        {
          timestamp: [3.2, 5.5],
          text: "AI-powered subtitles for any video.",
        },
      ],
    }

    // 3. Normalize into structured SubtitleSegments
    const segments = normalizeSegments(rawAsrOutput)
    expect(segments.length).toBe(2)
    expect(segments[0].start).toBe(0.5)
    expect(segments[0].end).toBe(2.5)

    // 4. Build output SRT string
    const generatedSrt = buildSrt(segments)
    expect(generatedSrt).toBeDefined()
    expect(generatedSrt.length).toBeGreaterThan(0)

    // 5. Persist generated subtitle file to build-outputs
    fs.mkdirSync(outDir, { recursive: true })
    const generatedSrtPath = path.join(outDir, "generated_demo_speech.srt")
    fs.writeFileSync(generatedSrtPath, generatedSrt, "utf-8")
    expect(fs.existsSync(generatedSrtPath)).toBe(true)

    // 6. Parse generated output and empirically contrast against Golden Reference
    const generatedCues = parseSrt(generatedSrt)
    const diffReport = contrastSubtitles(goldenCues, generatedCues, 100, 0.95)

    // 7. Assertions
    expect(diffReport.passed).toBe(true)
    expect(diffReport.totalExpectedCues).toBe(diffReport.totalActualCues)
    expect(diffReport.maxTimestampDriftMs).toBeLessThanOrEqual(50)
    expect(diffReport.textSimilarityPercent).toBeGreaterThanOrEqual(95)
    expect(diffReport.wordErrorRatePercent).toBe(0)
    expect(diffReport.errors.length).toBe(0)
  })

  it("handles empty or silent audio output gracefully without corrupting SRT files", () => {
    const emptyOutput = { text: "", chunks: [] }
    const segments = normalizeSegments(emptyOutput)
    const srt = buildSrt(segments)
    expect(srt).toBe("")
  })
})
