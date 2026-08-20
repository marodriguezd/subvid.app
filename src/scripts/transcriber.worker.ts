// Dedicated Web Worker that hosts the Whisper ASR transformers.js pipeline.
// Loading and running inference is heavy CPU/WASM work that would otherwise
// freeze the main thread (the UI, progress bars, etc.).
//
// Protocol (main ⇄ worker):
//   → { id, type: "ensure-asr", payload: { model, webgpu } }
//   → { id, type: "transcribe", payload: { audio, language, wordTimestamps } }
//                                                             // audio buffer transferred
//   ← { type: "progress", key, payload }   // streamed model-download progress
//   ← { type: "chunk" }                     // streamed per-chunk ASR progress
//   ← { id, type: "done", result? }         // request finished
//   ← { id, type: "error", error }          // request failed

import { env, pipeline } from "@huggingface/transformers";

env.allowLocalModels = false;
env.useBrowserCache = true;

// Force WASM/CPU backend only to avoid mobile/desktop GPU memory crashes
if (typeof navigator !== "undefined" && (navigator as any).gpu) {
  Object.defineProperty(navigator, "gpu", {
    get: function () {
      return undefined;
    },
    configurable: true,
  });
}

// Configure ONNX WebAssembly environment for maximum stability and speed
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.simd = true;
  env.backends.onnx.wasm.proxy = false;
}

let recognizer: any = null;
let recognizerDevice: "webgpu" | "wasm" = "wasm";
let recognizerModel: string = "";

const post = (msg: any, transfer: Transferable[] = []) =>
  (self as any).postMessage(msg, transfer);

self.onmessage = async (event: MessageEvent) => {
  const { id, type, payload } = event.data || {};
  try {
    if (type === "ensure-asr") {
      if (!recognizer) {
        console.info("[ASR] Loading Whisper model (fp32 stable):", payload.model);

        // Force fp32 models to prevent ONNX Runtime 'TransposeDQWeightsForMatMulNBits' missing scale error
        recognizer = await pipeline("automatic-speech-recognition", payload.model, {
          progress_callback: (p: any) =>
            post({ type: "progress", key: "asr", payload: p }),
          dtype: {
            encoder_model: "fp32",
            decoder_model_merged: "fp32",
          },
        });

        recognizerDevice = "wasm";
        recognizerModel = payload.model;
        console.info("[ASR] Whisper model ready on WASM/CPU (fp32)");
      }
      post({ id, type: "done" });
    } else if (type === "transcribe") {
      let output
      try {
        output = await recognizer(payload.audio, {
          chunk_length_s: 30,
          stride_length_s: 5,
          return_timestamps: payload.wordTimestamps ? "word" : true,
          language: payload.language || null,
          chunk_callback: () => post({ type: "chunk" }),
        })
      } catch (err1: any) {
        console.warn(
          "[ASR] word timestamps failed, falling back to segment timestamps:",
          err1,
        )
        output = await recognizer(payload.audio, {
          chunk_length_s: 30,
          stride_length_s: 5,
          return_timestamps: true,
          language: payload.language || null,
          chunk_callback: () => post({ type: "chunk" }),
        })
      }
      post({ id, type: "done", result: output })
    } else {
      post({ id, type: "error", error: `Unknown message type: ${type}` });
    }
  } catch (err: any) {
    post({ id, type: "error", error: String(err?.message || err) });
  }
};
