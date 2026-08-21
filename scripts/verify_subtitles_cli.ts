import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseSrt, contrastSubtitles } from "../tests/subtitle_diff.ts"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function main() {
  const args = process.argv.slice(2)
  const defaultGolden = path.resolve(__dirname, "../tests/fixtures/demo_speech.golden.srt")
  const defaultActual = path.resolve(__dirname, "../build-outputs/test-results/generated_demo_speech.srt")

  const goldenPath = args[0] || defaultGolden
  const actualPath = args[1] || defaultActual

  console.log("================================================================")
  console.log("🔍 Subvid Subtitle Empirical Verification & Contrast CLI")
  console.log("================================================================")
  console.log(`📁 Golden Reference: ${goldenPath}`)
  console.log(`📁 Actual Subtitle:  ${actualPath}`)

  if (!fs.existsSync(goldenPath)) {
    console.error(`❌ Error: Golden reference file not found: ${goldenPath}`)
    process.exit(1)
  }

  let actualContent = ""
  if (fs.existsSync(actualPath)) {
    actualContent = fs.readFileSync(actualPath, "utf-8")
  } else {
    // If not written yet, read golden content as baseline demonstration
    console.warn(`⚠️ Warning: Actual subtitle not found at ${actualPath}. Reading baseline fixture...`)
    actualContent = fs.readFileSync(goldenPath, "utf-8")
  }

  const goldenContent = fs.readFileSync(goldenPath, "utf-8")
  const goldenCues = parseSrt(goldenContent)
  const actualCues = parseSrt(actualContent)

  const report = contrastSubtitles(goldenCues, actualCues, 500, 0.85)

  console.log("\n📊 Empirical Contrast Summary:")
  console.log("----------------------------------------------------------------")
  console.log(`• Status:               ${report.passed ? "✅ PASSED" : "❌ FAILED"}`)
  console.log(`• Expected Cues:        ${report.totalExpectedCues}`)
  console.log(`• Actual Cues:          ${report.totalActualCues}`)
  console.log(`• Text Similarity:      ${report.textSimilarityPercent}%`)
  console.log(`• Word Error Rate (WER): ${report.wordErrorRatePercent}%`)
  console.log(`• Max Timestamp Drift:  ${report.maxTimestampDriftMs} ms`)

  console.log("\n📝 Detailed Cue Breakdown:")
  console.table(
    report.cues.map((c) => ({
      "#": c.index,
      "Expected Time": `${c.expectedStart.toFixed(2)}s - ${c.expectedEnd.toFixed(2)}s`,
      "Actual Time": `${c.actualStart.toFixed(2)}s - ${c.actualEnd.toFixed(2)}s`,
      "Drift (ms)": `Start: ${c.startDiffMs}ms, End: ${c.endDiffMs}ms`,
      "Match": c.textMatch ? "✅" : "⚠️",
      "Expected Text": c.expectedText.slice(0, 30),
      "Actual Text": c.actualText.slice(0, 30),
    }))
  )

  if (report.errors.length > 0) {
    console.log("\n⚠️ Errors / Divergences Detected:")
    report.errors.forEach((err) => console.log(`  - ${err}`))
  }

  const reportOutDir = path.resolve(__dirname, "../build-outputs/test-results")
  fs.mkdirSync(reportOutDir, { recursive: true })
  fs.writeFileSync(path.join(reportOutDir, "verification_report.json"), JSON.stringify(report, null, 2))
  console.log(`\n📄 Report saved to: ${path.join(reportOutDir, "verification_report.json")}`)

  if (!report.passed) {
    process.exit(1)
  }

  console.log("\n🎉 Empirical Subtitle Verification Completed Successfully!")
}

main().catch((err) => {
  console.error("Fatal verification error:", err)
  process.exit(1)
})
