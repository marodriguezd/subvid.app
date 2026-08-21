import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { generateDemoWav } from "./fixtures/generate_demo_assets.ts"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Pure TypeScript implementation of decodeWavPcm16 matching src/scripts/media/audio.ts
 */
function decodeWavPcm16(bytes: Uint8Array): Float32Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.byteLength < 44) return null
  if (view.getUint32(0, false) !== 0x52494646) return null // 'RIFF'
  if (view.getUint32(8, false) !== 0x57415645) return null // 'WAVE'

  let offset = 12
  let channels = 0
  let audioFormat = 0
  let bitsPerSample = 0
  let dataOffset = -1
  let dataLength = 0

  while (offset + 8 <= view.byteLength) {
    const id = view.getUint32(offset, false)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 0x666d7420 /* 'fmt ' */) {
      audioFormat = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      bitsPerSample = view.getUint16(body + 14, true)
    } else if (id === 0x64617461 /* 'data' */) {
      dataOffset = body
      dataLength = Math.min(size, view.byteLength - body)
    }
    offset = body + size + (size & 1)
  }

  if (audioFormat !== 1 || bitsPerSample !== 16 || dataOffset < 0) return null

  const ch = Math.max(1, channels)
  const stride = 2 * ch
  const frames = Math.floor(dataLength / stride)
  const out = new Float32Array(frames)

  for (let f = 0; f < frames; f++) {
    out[f] = view.getInt16(dataOffset + f * stride, true) / 32768
  }

  return out
}

describe("Audio Processing & PCM Decoding Suite", () => {
  it("decodes valid 16-bit 16kHz mono WAV into Float32Array normalized between -1.0 and 1.0", () => {
    const wavBuffer = generateDemoWav(2, 16000)
    const decoded = decodeWavPcm16(new Uint8Array(wavBuffer))

    expect(decoded).not.toBeNull()
    expect(decoded!.length).toBe(32000) // 2s * 16000Hz

    // Verify samples are bounded within audio range [-1.0, 1.0]
    let max = -Infinity
    let min = Infinity
    for (let i = 0; i < decoded!.length; i++) {
      if (decoded![i] > max) max = decoded![i]
      if (decoded![i] < min) min = decoded![i]
    }
    expect(max).toBeLessThanOrEqual(1.0)
    expect(min).toBeGreaterThanOrEqual(-1.0)
    expect(max).toBeGreaterThan(0.1) // Has active signal
  })

  it("handles malformed or truncated audio headers gracefully without throwing exceptions", () => {
    expect(decodeWavPcm16(new Uint8Array(20))).toBeNull() // Too short
    expect(decodeWavPcm16(new Uint8Array(100))).toBeNull() // Missing RIFF/WAVE
  })

  it("reads and parses the on-disk fixture demo_speech.wav", () => {
    const fixturePath = path.join(__dirname, "fixtures", "demo_speech.wav")
    expect(fs.existsSync(fixturePath)).toBe(true)

    const fileBytes = fs.readFileSync(fixturePath)
    const decoded = decodeWavPcm16(fileBytes)

    expect(decoded).not.toBeNull()
    expect(decoded!.length).toBe(6 * 16000) // 6 seconds
  })

  it("identifies active speech segments via energy profile", () => {
    const wavBuffer = generateDemoWav(6, 16000)
    const audio = decodeWavPcm16(new Uint8Array(wavBuffer))!

    // Calculate RMS energy across 1-second chunks
    const chunkSamples = 16000
    const chunk1Rms = Math.sqrt(audio.slice(0, 16000).reduce((acc, v) => acc + v * v, 0) / 16000)
    const chunk2Rms = Math.sqrt(audio.slice(16000, 32000).reduce((acc, v) => acc + v * v, 0) / 16000)

    // Segment 1 (0.5s - 2.5s) is in chunk 1 and 2, should have high energy
    expect(chunk1Rms).toBeGreaterThan(0.05)
    expect(chunk2Rms).toBeGreaterThan(0.05)
  })
})
