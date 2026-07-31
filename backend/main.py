"""
NeMo Canary Transcription Backend
==================================
FastAPI server that exposes transcription endpoints using
nvidia/canary-180m-flash via NVIDIA NeMo.

Endpoints:
    POST /api/transcribe          — Synchronous (backward compat)
    POST /api/transcribe/stream   — Returns { job_id }, starts async transcription
    GET  /api/transcribe/{job_id}/events  — SSE progress stream

Requires: ffmpeg, libsndfile (system), GPU recommended
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import tempfile
import threading
import time
import traceback
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CANARY_MODEL_NAME = os.getenv("CANARY_MODEL", "nvidia/canary-180m-flash")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
SAMPLE_RATE = 16000

CANARY_LANGS = frozenset({"en", "es", "de", "fr"})

MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_MB", "500")) * 1024 * 1024
MAX_AUDIO_SECONDS = int(os.getenv("MAX_AUDIO_SECONDS", "7200"))
JOB_TTL_SECONDS = int(os.getenv("JOB_TTL_SECONDS", "3600"))

# VAD parameters
VAD_FRAME_MS = 25       # frame length for energy computation
VAD_HOP_MS = 10         # hop between frames
VAD_SILENCE_THRESHOLD = 0.02  # RMS energy below this = silence
VAD_MIN_SPEECH_MS = 300       # minimum speech segment duration
VAD_MIN_SILENCE_MS = 400      # minimum silence between segments
VAD_MAX_CHUNK_MS = 30_000     # max chunk duration (30s)

model = None

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class TranscriptionChunk(BaseModel):
    timestamp: list[float]
    text: str

class TranscriptionResponse(BaseModel):
    text: str
    chunks: list[TranscriptionChunk]
    language: str

class JobStartResponse(BaseModel):
    job_id: str
    stream_url: str

class HealthResponse(BaseModel):
    status: str
    model: str
    device: str
    model_loaded: bool

# ---------------------------------------------------------------------------
# In-memory job store
# ---------------------------------------------------------------------------

_jobs: dict[str, dict] = {}
_jobs_lock = asyncio.Lock()


async def _create_job() -> str:
    job_id = uuid.uuid4().hex[:12]
    async with _jobs_lock:
        _jobs[job_id] = {
            "id": job_id,
            "status": "pending",  # pending | preprocessing | transcribing | done | error
            "progress": 0,
            "message": "",
            "chunks_done": 0,
            "total_chunks": 0,
            "result": None,
            "error": None,
            "event": asyncio.Event(),  # signaled when status changes
            "created_at": time.monotonic(),
        }
    return job_id


async def _update_job(job_id: str, **kwargs):
    async with _jobs_lock:
        if job_id in _jobs:
            _jobs[job_id].update(kwargs)
            _jobs[job_id]["event"].set()
            _jobs[job_id]["event"] = asyncio.Event()  # reset for next update


async def _cleanup_old_jobs():
    """Remove jobs older than JOB_TTL_SECONDS."""
    now = time.monotonic()
    async with _jobs_lock:
        expired = [
            jid for jid, j in _jobs.items()
            if now - j["created_at"] > JOB_TTL_SECONDS
        ]
        for jid in expired:
            wav = _jobs[jid].pop("_wav_path", None)
            if wav:
                Path(wav).unlink(missing_ok=True)
            del _jobs[jid]

# ---------------------------------------------------------------------------
# Audio preprocessing
# ---------------------------------------------------------------------------

def convert_to_wav_16k_mono(input_bytes: bytes, suffix: str) -> str:
    """Convert audio/video to 16kHz mono WAV. Returns path (caller cleans up)."""
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as in_f:
        in_f.write(input_bytes)
        in_path = in_f.name

    out_path = in_path + ".wav"

    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", in_path, "-vn", "-ac", "1", "-ar",
             str(SAMPLE_RATE), "-f", "wav", out_path],
            capture_output=True, text=True, timeout=300,
        )
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {result.stderr}")
    finally:
        Path(in_path).unlink(missing_ok=True)

    try:
        info = sf.info(out_path)
        if info.duration < 0.1:
            Path(out_path).unlink(missing_ok=True)
            raise ValueError("Audio too short or silent.")
        if info.duration > MAX_AUDIO_SECONDS:
            Path(out_path).unlink(missing_ok=True)
            raise ValueError(
                f"Audio too long ({info.duration:.0f}s). Max {MAX_AUDIO_SECONDS}s."
            )
    except ValueError:
        raise
    except Exception:
        Path(out_path).unlink(missing_ok=True)
        raise

    return out_path

# ---------------------------------------------------------------------------
# VAD: energy-based silence detection
# ---------------------------------------------------------------------------

def vad_split(wav_path: str) -> list[tuple[float, float]]:
    """Split audio into speech segments using energy-based VAD.

    Returns list of (start_sec, end_sec) tuples.
    """
    data, sr = sf.read(wav_path, dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)

    frame_samples = int(sr * VAD_FRAME_MS / 1000)
    hop_samples = int(sr * VAD_HOP_MS / 1000)
    frame_count = max(1, (len(data) - frame_samples) // hop_samples + 1)

    # Compute RMS energy per frame
    energies = np.zeros(frame_count, dtype=np.float32)
    for i in range(frame_count):
        start = i * hop_samples
        end = min(len(data), start + frame_samples)
        chunk = data[start:end]
        energies[i] = np.sqrt(np.mean(chunk * chunk))

    # Dynamic threshold
    sorted_e = np.sort(energies)
    noise_floor = np.percentile(sorted_e, 20)
    voice_level = np.percentile(sorted_e, 85)
    threshold = max(0.003, noise_floor * 4, voice_level * 0.12)

    # Find speech segments
    min_speech_frames = int(VAD_MIN_SPEECH_MS / VAD_HOP_MS)
    min_silence_frames = int(VAD_MIN_SILENCE_MS / VAD_HOP_MS)
    max_chunk_frames = int(VAD_MAX_CHUNK_MS / VAD_HOP_MS)

    segments: list[tuple[float, float]] = []
    in_speech = False
    speech_start = 0
    silence_count = 0
    frames_in_chunk = 0

    for i, energy in enumerate(energies):
        if energy >= threshold:
            if not in_speech:
                speech_start = i
                in_speech = True
                frames_in_chunk = 0
            silence_count = 0
            frames_in_chunk += 1

            # Force split for very long chunks
            if frames_in_chunk >= max_chunk_frames:
                t_start = speech_start * hop_samples / sr
                t_end = (i + 1) * hop_samples / sr
                t_end = min(t_end, len(data) / sr)
                if t_end - t_start >= 0.3:
                    segments.append((t_start, t_end))
                speech_start = i + 1
                frames_in_chunk = 0
        else:
            if in_speech:
                silence_count += 1
                if silence_count >= min_silence_frames and frames_in_chunk >= min_speech_frames:
                    t_start = speech_start * hop_samples / sr
                    t_end = (i - silence_count + 1) * hop_samples / sr
                    if t_end - t_start >= 0.3:
                        segments.append((t_start, t_end))
                    in_speech = False

    # Final segment
    if in_speech and frames_in_chunk >= min_speech_frames:
        t_start = speech_start * hop_samples / sr
        t_end = len(data) / sr
        if t_end - t_start >= 0.3:
            segments.append((t_start, t_end))

    return segments

# ---------------------------------------------------------------------------
# Canary model
# ---------------------------------------------------------------------------

def load_canary_model():
    global model
    if model is not None:
        return model
    from nemo.collections.asr.models import EncDecMultiTaskModel

    print(f"[canary] Loading '{CANARY_MODEL_NAME}' on {DEVICE} ...")
    t0 = time.monotonic()
    model = EncDecMultiTaskModel.from_pretrained(CANARY_MODEL_NAME)
    model = model.to(DEVICE)
    model.eval()
    print(f"[canary] Loaded in {time.monotonic() - t0:.1f}s on {DEVICE}")
    return model


def free_gpu_memory():
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.synchronize()


def parse_canary_output(results, audio_duration: float) -> dict:
    """Parse NeMo Canary output into { text, chunks: [{timestamp, text}], language }.

    Handles all known NeMo return types: str, dict, list, Hypothesis.
    """
    full_text = ""
    chunks: list[dict] = []

    if isinstance(results, list) and len(results) > 0:
        first = results[0]

        # Handle Hypothesis objects (NeMo's internal transcription result type).
        # Split each sentence INTO WORD-LEVEL chunks with timestamps distributed
        # by character count (longer words get more time, matching natural speech).
        # This tricks the frontend's normalizeSegments into applying the same
        # word-level pipeline that the local Whisper path uses — aspect-ratio
        # line limits, max chars/words/duration, silence-gap splits. If the
        # client also sends back the audio buffer, refineSegmentsWithSpeechRuns
        # corrects these proportional timestamps to actual speech edges via VAD.
        if hasattr(first, "text") and not isinstance(first, (str, dict)):
            for i, hyp in enumerate(results):
                text = str(getattr(hyp, "text", "")).strip()
                if not text:
                    continue
                # Sentence-level timing from NeMo if available; fall back to
                # evenly-spaced within audio duration.
                n = len(results)
                seg_dur = audio_duration / max(1, n)
                sentence_start = float(
                    getattr(hyp, "start_time", getattr(hyp, "start", i * seg_dur))
                )
                sentence_end = float(
                    getattr(hyp, "end_time", getattr(hyp, "end", sentence_start + seg_dur))
                )
                if sentence_start >= audio_duration or sentence_end <= 0:
                    sentence_start = i * seg_dur
                    sentence_end = sentence_start + seg_dur
                full_text += " " + text
                words = text.split()
                if len(words) <= 1:
                    chunks.append(
                        {"timestamp": [sentence_start, sentence_end], "text": text}
                    )
                    continue
                sentence_duration = max(0.05, sentence_end - sentence_start)
                # Drop rapid-fire hallucinated sentences before word-splitting
                # (otherwise we emit 10+ tiny word-chunks for a 1.5s window).
                # Real fast speech is ~0.25s/word, so 0.12s/word is a generous
                # threshold for >=5-word sentences — catches the worst loops
                # without dropping rapid legitimate phrases. Note: we do NOT
                # filter individual words here — the cleanup regexes
                # (`_REPEAT_CHAR_RE`, `_REPEAT_WORD_RE`) handle char/word loops,
                # and we deliberately skip a per-word syllable heuristic
                # because it corrupts legitimate words like Mississippi
                # (see _clean_canary_text docstring).
                if (
                    len(words) >= MIN_WORDS_FOR_RAPID_FIRE_DROP
                    and sentence_duration / len(words) < RAPID_FIRE_SEC_PER_WORD
                ):
                    continue
                # Proportional distribution weighted by character count.
                char_weights = [max(1, len(w)) for w in words]
                total_chars = sum(char_weights)
                cursor = sentence_start
                for w, weight in zip(words, char_weights):
                    word_dur = sentence_duration * (weight / total_chars)
                    chunks.append(
                        {"timestamp": [cursor, cursor + word_dur], "text": w}
                    )
                    cursor += word_dur
            full_text = full_text.strip()

        elif isinstance(first, str):
            full_text = first.strip()
            chunks = [{"timestamp": [0.0, audio_duration or 6.0], "text": full_text}]

        elif isinstance(first, dict):
            for i, seg in enumerate(results):
                if isinstance(seg, dict):
                    text = str(seg.get("text", "")).strip()
                    if not text:
                        continue
                    start = float(seg.get("start_time", seg.get("start", i * 2.0)))
                    end = float(seg.get("end_time", seg.get("end", start + 2.0)))
                    chunks.append({"timestamp": [start, end], "text": text})
                    full_text += " " + text
                elif hasattr(seg, "text"):
                    text = str(getattr(seg, "text", "")).strip()
                    if text:
                        chunks.append({"timestamp": [i * 2.0, (i + 1) * 2.0], "text": text})
                        full_text += " " + text
            full_text = full_text.strip()

        else:
            raise RuntimeError(
                f"Unexpected segment type: {type(first)}. Raw: {str(first)[:200]}"
            )

    elif isinstance(results, str):
        full_text = results.strip()
        chunks = [{"timestamp": [0.0, audio_duration or 6.0], "text": full_text}]

    elif hasattr(results, "text"):
        # Single Hypothesis object
        text = str(getattr(results, "text", "")).strip()
        full_text = text
        chunks = [{"timestamp": [0.0, audio_duration or 6.0], "text": text}]

    else:
        raise RuntimeError(
            f"Unexpected output format: {type(results)}. Raw: {str(results)[:200]}"
        )

    if not chunks:
        full_text = ""
        chunks = [{"timestamp": [0.0, 1.0], "text": ""}]

    return {"text": full_text, "chunks": chunks}

# ---------------------------------------------------------------------------
# Text cleanup: strip model artifacts and hallucinated loops
# ---------------------------------------------------------------------------

# Canary/NLLB uses <|...|> special tokens. Two-pass cleanup to avoid eating
# legitimate "<" characters in transcribed text (e.g. "5 < 10"):
#   1. Standard form: <|token_name|> (opening + closing pipe)
#   2. Malformed variants: <lendof...> or <lendotext> (no pipes, no closing)
_SPECIAL_TOKEN_RE = re.compile(
    r"<\|[\w|]+\|>"           # <|endoftext|>, <|nospeech|>, etc.
    r"|<lendo\w*>?",          # <lendoftext>, <lendotffextl>, <lendotfwRM>, <lendof>
    flags=re.IGNORECASE,      # also catches <LENDOF> uppercase variants
)
# 5+ consecutive identical characters → single instance (catches 'aaaaaaa' model
# loops while preserving legitimate emphatic speech like 'noooo!' or 'ahhhh').
_REPEAT_CHAR_RE = re.compile(r"(.)\1{4,}")
# 3+ consecutive identical words → single instance (catches
# 'light light light light' hallucinated repetitions). Allows optional commas
# between repeats ('lights, lights, lights, ...') and apostrophes inside words
# so contractions like 'we're gonna, we're gonna' collapse correctly. Case-
# insensitive so 'We're' / 'we're' / 'WE'RE' all collapse; the replacement
# uses the first match's original casing.
_REPEAT_WORD_RE = re.compile(
    r"\b([\w']+)((?:\s*,\s*|\s+)\1\b){2,}", flags=re.IGNORECASE
)


def _clean_canary_text(text: str) -> str:
    """Strip Canary special tokens and collapse degenerate repetitions.

    We intentionally do NOT collapse syllable-level repetitions inside a word:
    a regex like `(\\w{2,5})\\1{1,}` happily corrupts legitimate words
    (Mississippi → Missippi, banana → bana, noooo! → noo!). Canary's
    hallucination loops are caught by the sentence-level rapid-fire drop in
    `parse_canary_output` (`>5 words with < 0.12s/word`) before they reach
    word-split, so per-word scrubbing isn't needed.
    """
    if not text:
        return text
    text = _SPECIAL_TOKEN_RE.sub(" ", text)
    text = _REPEAT_CHAR_RE.sub(r"\1", text)
    text = _REPEAT_WORD_RE.sub(r"\1", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _is_degenerate(text: str) -> bool:
    """True if text is the model hallucinating a single character or alternating.

    Protects short emphatic speech ("noooo!", "ahhhh") by requiring:
    - single-char repeats to be at any length (clear hallucination)
    - 2-char alternations (e.g. "AaAaAa...") to be 20+ chars long
    """
    if not text:
        return False
    alpha = [c for c in text.lower() if c.isalpha()]
    if len(alpha) < 4:
        return False
    unique = len(set(alpha))
    if unique <= 1:
        # "aaaaaa" — single character repeated, always degenerate
        return True
    if unique <= 2 and len(alpha) >= 20:
        # "AaAaAaAa..." — alternating pattern, only degenerate when very long
        return True
    return False


# ---------------------------------------------------------------------------
# Chunking strategy (no VAD — fixed-size chunks to avoid missing speech)
# ---------------------------------------------------------------------------

# Defaults kept here so they're easy to find / tune. The chunker uses fixed
# 20s chunks with 1s acoustic context padding on each side. The padding gives
# Canary boundary context (a word at t=19.95s benefits from hearing ~0.05s of
# previous audio) WITHOUT producing duplicates: each word is assigned to the
# single chunk whose CORE window contains its timestamp midpoint (the 1s
# overlap zones are then dropped — see _run_transcription_sync). This
# eliminates duplicate subtitles by construction while keeping Canary happy.
# We deliberately avoid VAD-driven chunking (VAD_MIN_SPEECH_MS, energy
# threshold) because those parameters dropped quiet / mumbled sections of
# speech — the user reported that fragments were being skipped.
SHORT_AUDIO_THRESHOLD_SEC = 25.0
FIXED_CHUNK_SEC = 20.0
CONTEXT_PAD_SEC = 1.0
MIN_CHUNK_SEC = 0.1  # skip only truly trivial trailing tails (< 100ms)
# Hallucinated Canary sentences often pack many words into a few seconds
# (e.g., 10 repeated words in 1s = 0.1s/word). Real fast speech is ~0.25s/word,
# so 0.12s/word is a generous-but-safe drop threshold for sentences with >=5
# words (avoids dropping short legitimate phrases).
RAPID_FIRE_SEC_PER_WORD = 0.12
MIN_WORDS_FOR_RAPID_FIRE_DROP = 5


def build_chunk_specs(
    audio_duration: float,
    fixed_chunk_sec: float = FIXED_CHUNK_SEC,
    context_pad_sec: float = CONTEXT_PAD_SEC,
    short_threshold_sec: float = SHORT_AUDIO_THRESHOLD_SEC,
    min_chunk_sec: float = MIN_CHUNK_SEC,
) -> list[tuple[float, float, float, float]]:
    """Return [(padded_start, padded_end, core_start, core_end), ...] tuples.

    For each spec, Canary receives audio from [padded_start, padded_end)
    (with extra context for boundary disambiguation). Output timestamps
    are then clamped to [core_start, core_end) so the editor displays each
    subtitle inside its non-overlapping fixed-length segment.

    Short audio (<= short_threshold_sec): one spec covering the full
    duration so the model gets maximum context.

    Long audio: fixed `fixed_chunk_sec` chunks. Every second of audio is
    covered — no VAD is used, so no speech segment can be silently dropped.

    Trailing tails shorter than `min_chunk_sec` are skipped (would yield
    little useful content for the model).
    """
    if audio_duration <= short_threshold_sec:
        return [(0.0, audio_duration, 0.0, audio_duration)]

    specs: list[tuple[float, float, float, float]] = []
    cursor = 0.0
    while cursor < audio_duration:
        core_end = min(audio_duration, cursor + fixed_chunk_sec)
        if core_end - cursor < min_chunk_sec:
            break
        padded_start = max(0.0, cursor - context_pad_sec)
        padded_end = min(audio_duration, core_end + context_pad_sec)
        specs.append((padded_start, padded_end, cursor, core_end))
        cursor += fixed_chunk_sec
    return specs


# ---------------------------------------------------------------------------
# Background transcription runner
# ---------------------------------------------------------------------------

def _run_transcription_sync(
    wav_path: str,
    source_lang: str,
    target_lang: str,
    pnc: bool,
    job_id: str,
    loop: asyncio.AbstractEventLoop,
):
    """Run transcription in a background thread, sending progress via asyncio."""
    def emit(event_type: str, data: dict):
        """Fire-and-forget progress update. Non-blocking."""
        data["status"] = data.get("status", event_type)
        asyncio.run_coroutine_threadsafe(_update_job(job_id, **data), loop)

    try:
        # --- Preprocessing ---
        emit("progress", {
            "progress": 5,
            "message": "Analyzing audio for speech segments...",
            "chunks_done": 0,
            "total_chunks": 0,
        })

        segments = vad_split(wav_path)
        audio_duration = sf.info(wav_path).duration

        # Handle silent audio
        if len(segments) == 0:
            emit("result", {
                "status": "done",
                "progress": 100,
                "message": "No speech detected",
                "chunks_done": 0,
                "total_chunks": 0,
                "result": {
                    "text": "",
                    "chunks": [{"timestamp": [0.0, audio_duration], "text": ""}],
                    "language": source_lang,
                },
            })
            return

        # --- Decide transcription strategy ---
        # Short audio (<=25s): transcribe the whole file in one shot. Maximum
        # context for the model, no boundary artifacts.
        # Long audio (>25s): FIXED 20s chunks with CONTEXT_PAD_SEC of acoustic
        # context on each side. We no longer use VAD to choose chunk boundaries
        # because VAD can miss quiet / mumbled speech (its MIN_SPEECH_MS=300
        # and energy threshold drop sections). Fixed chunks guarantee that
        # every second of audio is transcribed; the user reported that
        # VAD-based chunking was skipping important fragments. Each chunk is
        # sent to Canary with ±CONTEXT_PAD_SEC of surrounding audio as
        # acoustic context (so a word at t=19.95s benefits from a bit of
        # previous audio). The output is then deduplicated by MIDPOINT: each
        # word is assigned to the single chunk whose CORE window contains
        # its midpoint, so the 1s overlap zones are dropped and no duplicate
        # subtitles are emitted.
        chunk_specs: list[tuple[float, float, float, float]] = build_chunk_specs(
            audio_duration=audio_duration,
        )
        total_segments = len(chunk_specs)

        emit("progress", {
            "progress": 10,
            "            message": f"Processing {total_segments} {FIXED_CHUNK_SEC:.0f}s chunks ({audio_duration:.0f}s audio)",
            "chunks_done": 0,
            "total_chunks": total_segments,
        })

        # --- Load model ---
        emit("progress", {
            "progress": 15,
            "message": "Loading Canary model...",
            "chunks_done": 0,
            "total_chunks": total_segments,
        })

        canary = load_canary_model()

        emit("progress", {
            "progress": 20,
            "message": f"Transcribing segment 1 of {total_segments}...",
            "chunks_done": 0,
            "total_chunks": total_segments,
        })

        # --- Read WAV data once (not inside the loop!) ---
        wav_data, sr = sf.read(wav_path, dtype="float32")
        if wav_data.ndim > 1:
            wav_data = wav_data.mean(axis=1)

        # --- Transcribe with context-aware chunks ---
        all_chunks: list[dict] = []

        for idx, (seg_start, seg_end, core_start, core_end) in enumerate(chunk_specs):

            start_sample = int(seg_start * sr)
            end_sample = int(seg_end * sr)
            seg_audio = wav_data[start_sample:end_sample].copy()

            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                seg_path = f.name
            try:
                sf.write(seg_path, seg_audio, sr)

                with torch.inference_mode():
                    result = canary.transcribe(
                        audio=[seg_path],
                        source_lang=source_lang,
                        target_lang=target_lang,
                        pnc="yes" if pnc else "no",
                        batch_size=1,
                        num_workers=0,
                        verbose=False,
                    )

                # Parse, clean, and translate timestamps back to the original timeline.
                parsed = parse_canary_output(result, seg_end - seg_start)
                kept: list[dict] = []
                for chunk in parsed["chunks"]:
                    # Strip Canary special tokens (<|endoftext|>, partial
                    # <lendoftextl>) and collapse hallucinated char/word loops.
                    chunk["text"] = _clean_canary_text(chunk["text"])
                    if _is_degenerate(chunk["text"]):
                        # Model was looping on a single character — drop it.
                        continue
                    # Canary timestamps are relative to the padded window.
                    abs_start = chunk["timestamp"][0] + seg_start
                    abs_end = chunk["timestamp"][1] + seg_start
                    # Midpoint-based dedup: when CONTEXT_PAD_SEC > 0, adjacent
                    # chunks share a 2s overlap zone and BOTH transcribe it.
                    # Assign each word to the SINGLE chunk whose core window
                    # contains its timestamp midpoint — eliminates duplicate
                    # subtitles by construction (no overlap → no duplicates).
                    midpoint = (abs_start + abs_end) / 2.0
                    if not (core_start <= midpoint < core_end):
                        continue
                    # Clamp into the core window so the editor displays each
                    # subtitle inside its non-overlapping 20s segment.
                    chunk["timestamp"][0] = max(core_start, abs_start)
                    chunk["timestamp"][1] = min(core_end, abs_end)
                    if chunk["timestamp"][1] - chunk["timestamp"][0] < 0.05:
                        continue
                    kept.append(chunk)
                all_chunks.extend(kept)

            finally:
                Path(seg_path).unlink(missing_ok=True)

            # Progress update (non-blocking)
            chunks_done = idx + 1
            progress_pct = 20 + int(70 * chunks_done / total_segments)

            emit("progress", {
                "progress": progress_pct,
                "message": f"Transcribing chunk {chunks_done} of {total_segments}...",
                "chunks_done": chunks_done,
                "total_chunks": total_segments,
            })

        # --- Finalize ---
        full_text = " ".join(c["text"] for c in all_chunks).strip()

        emit("result", {
            "status": "done",
            "progress": 100,
            "message": "Transcription complete",
            "chunks_done": total_segments,
            "total_chunks": total_segments,
            "result": {
                "text": full_text,
                "chunks": all_chunks,
                "language": source_lang,
            },
        })

    except Exception as e:
        traceback.print_exc()
        emit("failure", {
            "status": "error",
            "progress": 0,
            "message": str(e),
            "chunks_done": 0,
            "total_chunks": 0,
            "error": str(e),
        })
        free_gpu_memory()

# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    preload = os.getenv("CANARY_PRELOAD", "0").lower() in ("1", "true", "yes")
    if preload:
        print("[canary] Preloading model...")
        load_canary_model()

    # Background job cleanup task
    async def _periodic_cleanup():
        while True:
            await asyncio.sleep(300)  # every 5 minutes
            await _cleanup_old_jobs()

    cleanup_task = asyncio.create_task(_periodic_cleanup())

    yield

    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass

    global model
    if model is not None:
        del model
        model = None
        free_gpu_memory()


app = FastAPI(title="NeMo Canary Transcription API", version="2.0.0", lifespan=lifespan)

_default_origins = os.getenv("CORS_ORIGINS", "http://localhost:4321,http://localhost:3000")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_default_origins.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(
        status="ok",
        model=CANARY_MODEL_NAME,
        device=DEVICE,
        model_loaded=model is not None,
    )


# ── Synchronous endpoint (backward compat) ──────────────────────────────

@app.post("/api/transcribe", response_model=TranscriptionResponse)
async def transcribe_sync(
    file: UploadFile = File(...),
    source_lang: str = Form(default="en"),
    target_lang: str = Form(default="en"),
    word_timestamps: bool = Form(default=True),
    pnc: bool = Form(default=True),
):
    """Synchronous transcription (no progress streaming)."""
    source_lang = source_lang.lower().strip()
    target_lang = target_lang.lower().strip()

    if source_lang not in CANARY_LANGS:
        raise HTTPException(400, detail=f"Unsupported source language '{source_lang}'")
    if target_lang not in CANARY_LANGS:
        raise HTTPException(400, detail=f"Unsupported target language '{target_lang}'")

    suffix = _get_suffix(file.content_type, file.filename)
    raw_bytes = await _read_file(file)
    wav_path = None

    try:
        wav_path = convert_to_wav_16k_mono(raw_bytes, suffix)
        result = _transcribe_full(wav_path, source_lang, target_lang, pnc)
        return TranscriptionResponse(
            text=result["text"],
            chunks=[TranscriptionChunk(**c) for c in result["chunks"]],
            language=result["language"],
        )
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, detail=str(e))
    finally:
        if wav_path:
            Path(wav_path).unlink(missing_ok=True)


def _transcribe_full(wav_path: str, source_lang: str, target_lang: str, pnc: bool) -> dict:
    """Transcribe entire WAV file with Canary (used by sync endpoint and streaming)."""
    canary = load_canary_model()
    t0 = time.monotonic()

    try:
        with torch.inference_mode():
            results = canary.transcribe(
                audio=[wav_path],
                source_lang=source_lang,
                target_lang=target_lang,
                pnc="yes" if pnc else "no",
                batch_size=1,
                num_workers=0,
                verbose=False,
            )
    except torch.cuda.OutOfMemoryError as e:
        free_gpu_memory()
        raise RuntimeError(f"GPU OOM: {e}") from e
    except RuntimeError as e:
        if "out of memory" in str(e).lower():
            free_gpu_memory()
        raise

    elapsed = time.monotonic() - t0
    try:
        dur = sf.info(wav_path).duration
    except Exception:
        dur = 0.0
    print(f"[canary] Done in {elapsed:.1f}s (audio: {dur:.1f}s, {DEVICE})")

    result = parse_canary_output(results, dur)
    result["language"] = source_lang
    return result


# ── Async streaming endpoint ────────────────────────────────────────────

@app.post("/api/transcribe/stream", response_model=JobStartResponse)
async def transcribe_stream_start(
    file: UploadFile = File(...),
    source_lang: str = Form(default="en"),
    target_lang: str = Form(default="en"),
    word_timestamps: bool = Form(default=True),
    pnc: bool = Form(default=True),
):
    """Start async transcription. Returns job_id for SSE streaming."""
    source_lang = source_lang.lower().strip()
    target_lang = target_lang.lower().strip()

    if source_lang not in CANARY_LANGS:
        raise HTTPException(400, detail=f"Unsupported source language '{source_lang}'")
    if target_lang not in CANARY_LANGS:
        raise HTTPException(400, detail=f"Unsupported target language '{target_lang}'")

    suffix = _get_suffix(file.content_type, file.filename)
    raw_bytes = await _read_file(file)

    # Create job
    job_id = await _create_job()

    # Convert to WAV and store path in job
    wav_path = convert_to_wav_16k_mono(raw_bytes, suffix)
    async with _jobs_lock:
        _jobs[job_id]["_wav_path"] = wav_path

    # Start background transcription
    loop = asyncio.get_event_loop()
    thread = threading.Thread(
        target=_run_transcription_sync,
        args=(wav_path, source_lang, target_lang, pnc, job_id, loop),
        daemon=True,
    )
    thread.start()

    return JobStartResponse(
        job_id=job_id,
        stream_url=f"/api/transcribe/{job_id}/events",
    )


@app.get("/api/transcribe/{job_id}/events")
async def transcribe_stream_events(job_id: str):
    """SSE stream of transcription progress."""

    async def event_generator():
        # Cleanup old jobs periodically
        await _cleanup_old_jobs()

        last_seen_progress = -1

        while True:
            async with _jobs_lock:
                job = _jobs.get(job_id)
                if not job:
                    yield f"event: failure\ndata: {json.dumps({'error': 'Job not found or expired'})}\n\n"
                    return
                status = job["status"]
                progress = job.get("progress", 0)
                message = job.get("message", "")
                chunks_done = job.get("chunks_done", 0)
                total_chunks = job.get("total_chunks", 0)
                result = job.get("result")
                error = job.get("error")

            if status in ("done", "error"):
                if status == "done" and result:
                    yield (
                        f"event: result\n"
                        f"data: {json.dumps({'progress': 100, 'chunks_done': total_chunks, 'total_chunks': total_chunks, 'message': 'Done', 'result': result})}\n\n"
                    )
                elif status == "error":
                    yield (
                        f"event: failure\n"
                        f"data: {json.dumps({'error': error or 'Unknown error', 'message': message})}\n\n"
                    )
                return

            if progress != last_seen_progress:
                yield (
                    f"event: progress\n"
                    f"data: {json.dumps({'progress': progress, 'chunks_done': chunks_done, 'total_chunks': total_chunks, 'message': message})}\n\n"
                )
                last_seen_progress = progress

            # Wait for next update or timeout
            async with _jobs_lock:
                if job_id in _jobs:
                    event = _jobs[job_id].get("event", asyncio.Event())
                else:
                    return

            try:
                await asyncio.wait_for(event.wait(), timeout=15.0)
            except asyncio.TimeoutError:
                # Send heartbeat
                yield f": heartbeat\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── Helpers ─────────────────────────────────────────────────────────────

def _get_suffix(content_type: str | None, filename: str | None) -> str:
    suffix_map = {
        "audio/wav": ".wav", "audio/mpeg": ".mp3", "audio/mp3": ".mp3",
        "audio/ogg": ".ogg", "video/mp4": ".mp4", "audio/webm": ".webm",
    }
    suffix = suffix_map.get(content_type or "")
    if not suffix:
        suffix = Path(filename or "audio.bin").suffix or ".bin"
    return suffix


async def _read_file(file: UploadFile) -> bytes:
    raw = bytearray()
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(413, f"File too large. Max {MAX_UPLOAD_BYTES // 1024 // 1024}MB.")
        raw.extend(chunk)
    if not raw:
        raise HTTPException(400, detail="Empty file")
    return bytes(raw)


# ── Entrypoint ──────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
