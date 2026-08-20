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
        console.info("[ASR] loading Whisper model (prioritizing q8 8-bit quantization):", payload.model);

        const loadModel = async (extraOptions: Record<string, any>) => {
          return await pipeline("automatic-speech-recognition", payload.model, {
            progress_callback: (p: any) =>
              post({ type: "progress", key: "asr", payload: p }),
            ...extraOptions,
          });
        };

        try {
          // Priority 1: q8 quantized sub-models (50% less RAM, 2x-3x faster inference, ~75MB download)
          recognizer = await loadModel({
            dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
          });
          console.info("[ASR] Loaded q8 sub-models successfully");
        } catch (e1) {
          console.warn("[ASR] q8 sub-models failed, trying generic q8:", e1);
          try {
            // Priority 2: generic q8
            recognizer = await loadModel({ dtype: "q8" });
            console.info("[ASR] Loaded generic q8 successfully");
          } catch (e2) {
            console.warn("[ASR] generic q8 failed, trying fp32 sub-models:", e2);
            try {
              // Priority 3: fp32 sub-models
              recognizer = await loadModel({
                dtype: { encoder_model: "fp32", decoder_model_merged: "fp32" },
              });
              console.info("[ASR] Loaded fp32 sub-models successfully");
            } catch (e3) {
              console.warn("[ASR] fp32 sub-models failed, trying generic fp32:", e3);
              try {
                // Priority 4: generic fp32
                recognizer = await loadModel({ dtype: "fp32" });
                console.info("[ASR] Loaded generic fp32 successfully");
              } catch (e4) {
                console.warn("[ASR] generic fp32 failed, trying default:", e4);
                // Priority 5: default resolution
                recognizer = await loadModel({});
                console.info("[ASR] Loaded default model successfully");
              }
            }
          }
        }

        recognizerDevice = "wasm";
        recognizerModel = payload.model;
        console.info("[ASR] Whisper model ready on WASM/CPU");
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
