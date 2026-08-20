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
        console.info("[ASR] loading Whisper model:", payload.model);

        const loadModel = async (extraOptions: Record<string, any>) => {
          return await pipeline("automatic-speech-recognition", payload.model, {
            progress_callback: (p: any) =>
              post({ type: "progress", key: "asr", payload: p }),
            ...extraOptions,
          });
        };

        try {
          // Attempt 1: fp32 sub-models (highest compatibility on WASM/CPU)
          recognizer = await loadModel({
            dtype: { encoder_model: "fp32", decoder_model_merged: "fp32" },
          });
        } catch (e1) {
          console.warn("[ASR] fp32 sub-models failed, trying fp32 string:", e1);
          try {
            // Attempt 2: generic fp32
            recognizer = await loadModel({ dtype: "fp32" });
          } catch (e2) {
            console.warn("[ASR] generic fp32 failed, trying default:", e2);
            // Attempt 3: default transformers.js resolution
            recognizer = await loadModel({});
          }
        }

        recognizerDevice = "wasm";
        recognizerModel = payload.model;
        console.info("[ASR] Whisper model loaded successfully on WASM/CPU");
      }
      post({ id, type: "done" });
    } else if (type === "transcribe") {
      const output = await recognizer(payload.audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: payload.wordTimestamps ? "word" : true,
        language: payload.language || null,
        chunk_callback: () => post({ type: "chunk" }),
      });
      post({ id, type: "done", result: output });
    } else {
      post({ id, type: "error", error: `Unknown message type: ${type}` });
    }
  } catch (err: any) {
    post({ id, type: "error", error: String(err?.message || err) });
  }
};
