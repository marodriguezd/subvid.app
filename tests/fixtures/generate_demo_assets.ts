import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Generates a valid 16kHz 16-bit Mono PCM WAV file with known speech-like audio envelope
 * and corresponding golden subtitle files (SRT, VTT, JSON).
 */
export function generateDemoWav(durationSeconds = 6, sampleRate = 16000): Buffer {
  const numSamples = Math.floor(durationSeconds * sampleRate)
  const blockAlign = 2 // 1 channel * 2 bytes (16-bit)
  const byteRate = sampleRate * blockAlign
  const dataSize = numSamples * blockAlign
  const buffer = Buffer.alloc(44 + dataSize)

  // 1. RIFF header
  buffer.write("RIFF", 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write("WAVE", 8)

  // 2. fmt subchunk
  buffer.write("fmt ", 12)
  buffer.writeUInt32LE(16, 16) // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20)  // AudioFormat (1 = PCM)
  buffer.writeUInt16LE(1, 22)  // NumChannels (1 = Mono)
  buffer.writeUInt32LE(sampleRate, 24) // SampleRate (16000)
  buffer.writeUInt32LE(byteRate, 28)   // ByteRate
  buffer.writeUInt16LE(blockAlign, 32) // BlockAlign
  buffer.writeUInt16LE(16, 34) // BitsPerSample (16)

  // 3. data subchunk
  buffer.write("data", 36)
  buffer.writeUInt32LE(dataSize, 40)

  // 4. Generate audio samples with distinct speech-like bursts at:
  // Burst 1: 0.5s -> 2.5s (Segment 1: "Welcome to Subvid subtitle generator.")
  // Burst 2: 3.2s -> 5.5s (Segment 2: "AI-powered subtitles for any video.")
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate
    let sampleVal = 0

    // Segment 1 active between 0.5s and 2.5s
    if (t >= 0.5 && t <= 2.5) {
      const syllableMod = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t)
      const speechTone =
        0.5 * Math.sin(2 * Math.PI * 180 * t) +
        0.3 * Math.sin(2 * Math.PI * 720 * t) +
        0.2 * Math.sin(2 * Math.PI * 1440 * t)
      sampleVal = speechTone * syllableMod * 0.7
    }
    // Segment 2 active between 3.2s and 5.5s
    else if (t >= 3.2 && t <= 5.5) {
      const syllableMod = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3.5 * t)
      const speechTone =
        0.5 * Math.sin(2 * Math.PI * 220 * t) +
        0.3 * Math.sin(2 * Math.PI * 880 * t) +
        0.2 * Math.sin(2 * Math.PI * 1760 * t)
      sampleVal = speechTone * syllableMod * 0.7
    } else {
      sampleVal = (Math.random() * 2 - 1) * 0.005
    }

    const int16 = Math.max(-32768, Math.min(32767, Math.floor(sampleVal * 32767)))
    buffer.writeInt16LE(int16, 44 + i * 2)
  }

  return buffer
}

export const GOLDEN_SEGMENTS = [
  {
    start: 0.5,
    end: 2.5,
    text: "Welcome to Subvid subtitle generator.",
  },
  {
    start: 3.2,
    end: 5.5,
    text: "AI-powered subtitles for any video.",
  },
]

export const GOLDEN_SRT = `1
00:00:00,500 --> 00:00:02,500
Welcome to Subvid subtitle generator.

2
00:00:03,200 --> 00:00:05,500
AI-powered subtitles for any video.`

export const GOLDEN_VTT = `WEBVTT

1
00:00:00.500 --> 00:00:02.500
Welcome to Subvid subtitle generator.

2
00:00:03.200 --> 00:00:05.500
AI-powered subtitles for any video.`

// Write files
const targetDir = path.resolve(__dirname)
fs.writeFileSync(path.join(targetDir, "demo_speech.wav"), generateDemoWav(6))
fs.writeFileSync(path.join(targetDir, "demo_speech.golden.srt"), GOLDEN_SRT.trim())
fs.writeFileSync(path.join(targetDir, "demo_speech.golden.vtt"), GOLDEN_VTT.trim())
fs.writeFileSync(path.join(targetDir, "demo_speech.golden.json"), JSON.stringify(GOLDEN_SEGMENTS, null, 2))

console.log("✅ Fixtures generated successfully in:", targetDir)
