"""Regression tests for backend/main.py:parse_canary_output and cleanup helpers.

Run with: python3 backend/tests/test_parse_canary.py  (plain asserts)
       or: pytest backend/tests/                    (requires pytest)
"""
import math
import sys
from pathlib import Path

# Add backend dir to path so we can import main
sys.path.insert(0, str(Path(__file__).parent.parent))

import main as m


class FakeHyp:
    """Simulate NeMo's Hypothesis object with start_time/end_time/text."""

    def __init__(self, text, start, end):
        self.text = text
        self.start_time = start
        self.end_time = end


def make_results(texts_with_timing):
    """Build a list of FakeHyp with given (text, start, end) tuples."""
    return [FakeHyp(text, start, end) for text, start, end in texts_with_timing]


# ── Hypothesis branch: word-level splitting ────────────────────────────


def test_single_word_sentence_keeps_sentence_timing():
    """A 1-word sentence falls through early-`continue` with sentence-level timing."""
    results = make_results([("yes", 1.0, 1.5)])
    parsed = m.parse_canary_output(results, audio_duration=10.0)
    assert len(parsed["chunks"]) == 1
    chunk = parsed["chunks"][0]
    assert chunk["text"] == "yes"
    assert chunk["timestamp"] == [1.0, 1.5]


def test_multiword_distributes_by_char_count():
    """Equal-length words → equal time per word."""
    # "ab cd" → 'ab' 2 chars, 'cd' 2 chars. Sentence 0.0–2.0s → 1s each word.
    results = make_results([("ab cd", 0.0, 2.0)])
    parsed = m.parse_canary_output(results, audio_duration=5.0)
    assert len(parsed["chunks"]) == 2
    assert parsed["chunks"][0]["text"] == "ab"
    assert parsed["chunks"][1]["text"] == "cd"
    assert parsed["chunks"][0]["timestamp"][0] == 0.0
    assert math.isclose(parsed["chunks"][0]["timestamp"][1], 1.0, abs_tol=1e-9)
    assert math.isclose(parsed["chunks"][1]["timestamp"][0], 1.0, abs_tol=1e-9)
    assert math.isclose(parsed["chunks"][1]["timestamp"][1], 2.0, abs_tol=1e-9)


def test_char_weighted_distribution():
    """Longer words proportionally get more time."""
    # "a bbbbb" → 'a' 1 char (1/6), 'bbbbb' 5 chars (5/6). Sentence 1s.
    results = make_results([("a bbbbb", 0.0, 1.0)])
    parsed = m.parse_canary_output(results, audio_duration=5.0)
    assert len(parsed["chunks"]) == 2
    assert parsed["chunks"][0]["text"] == "a"
    # 'a' starts at 0, ends at 1/6 ≈ 0.1667
    a_end = parsed["chunks"][0]["timestamp"][1]
    assert math.isclose(a_end, 1.0 / 6, abs_tol=1e-9)
    # 'bbbbb' starts where 'a' ended, ends at sentence_end=1.0
    assert math.isclose(parsed["chunks"][1]["timestamp"][0], a_end, abs_tol=1e-9)
    assert math.isclose(parsed["chunks"][1]["timestamp"][1], 1.0, abs_tol=1e-9)


def test_proportional_split_preserves_sentence_end():
    """Proportional distribution over N words reaches sentence_end
    (mathematically and within FP tolerance)."""
    text = "the quick brown fox jumps over the lazy dog"
    # 9 words, sentence 10.0–15.0s
    results = make_results([(text, 10.0, 15.0)])
    parsed = m.parse_canary_output(results, audio_duration=30.0)
    last = parsed["chunks"][-1]
    assert last["text"] == "dog"
    assert math.isclose(last["timestamp"][1], 15.0, abs_tol=1e-9)


def test_no_chunk_has_negative_duration():
    """Sanity: every chunk must have end >= start (regression guard).
    Catches future changes that might introduce clamping bugs.
    """
    # Pathological zero-duration sentence + single-word cases + normal.
    results = make_results([
        ("ab cd", 5.0, 5.0),                # floored
        ("yes", 10.0, 10.0),                # single-word floored
        ("Hello world", 20.0, 22.0),        # normal
        ("", 30.0, 31.0),                   # empty (skipped)
    ])
    parsed = m.parse_canary_output(results, audio_duration=30.0)
    for c in parsed["chunks"]:
        assert c["timestamp"][1] >= c["timestamp"][0], (
            f"negative duration: {c['text']!r} {c['timestamp']}"
        )


def test_empty_text_skipped():
    results = make_results([("", 1.0, 2.0), ("hi", 3.0, 3.5)])
    parsed = m.parse_canary_output(results, audio_duration=10.0)
    assert len(parsed["chunks"]) == 1
    assert parsed["chunks"][0]["text"] == "hi"


def test_falls_back_to_evenly_spaced_when_timestamps_invalid():
    """When start_time >= audio_duration, fall back to i * seg_dur.

    Sentence 'hello world' (2 words) becomes two word-chunks each ~5s,
    the last reaching the (fallback) sentence_end exactly.
    """
    results = [FakeHyp("hello world", 999.0, 1000.0)]  # way past audio end
    parsed = m.parse_canary_output(results, audio_duration=10.0)
    # seg_dur = 10 / 1 = 10. i=0: sentence_start=0, sentence_end=10.
    # First word "hello" runs 0→5, second "world" runs 5→10.
    assert parsed["chunks"][0]["timestamp"][0] == 0.0
    assert math.isclose(parsed["chunks"][0]["timestamp"][1], 5.0, abs_tol=1e-9)
    assert math.isclose(parsed["chunks"][1]["timestamp"][0], 5.0, abs_tol=1e-9)
    assert math.isclose(parsed["chunks"][1]["timestamp"][1], 10.0, abs_tol=1e-9)


def test_full_text_concatenates_all_words():
    """full_text equals original sentences joined by spaces."""
    results = make_results([("Hello world", 0.0, 2.0), ("Foo bar baz", 2.0, 5.0)])
    parsed = m.parse_canary_output(results, audio_duration=10.0)
    assert parsed["text"] == "Hello world Foo bar baz"


def test_rapid_fire_sentence_is_dropped():
    """Sentence with many words in a tiny duration is dropped (hallucination).

    Real fast speech is ~0.25s/word; 10 words in 0.5s = 0.05s/word is a clear
    hallucination loop. The sentence is dropped before word-splitting so the
    frontend doesn't see 10 tiny word-chunks for a single second of audio.
    """
    text = "lights lights lights lights lights lights lights lights lights lights"
    results = make_results([(text, 0.0, 0.5)])
    parsed = m.parse_canary_output(results, audio_duration=10.0)
    # parse_canary_output guarantees at least one chunk → placeholder returned.
    assert parsed["chunks"] == [{"timestamp": [0.0, 1.0], "text": ""}]
    assert parsed["text"] == ""


def test_rapid_fire_short_sentence_NOT_dropped():
    """Short sentences (< MIN_WORDS_FOR_RAPID_FIRE_DROP) pass through dense."""
    # 3 words in 0.4s = 0.13s/word but only 3 words (< 5 minimum), kept.
    text = "yes yes yes"
    results = make_results([(text, 0.0, 0.4)])
    parsed = m.parse_canary_output(results, audio_duration=10.0)
    assert len(parsed["chunks"]) >= 1
    assert parsed["chunks"][0]["text"] in {"yes yes yes", "yes"}


def test_legitimate_low_unique_word_survives():
    """Words with low unique-char ratio (like 'Mississippi') are NOT dropped.

    Regression: an earlier per-word heuristic flagged any 7+ char word with
    ≤50% unique alphabetic chars as 'repetitive' — this dropped legitimate
    words like Mississippi (4 unique chars out of 11 = 36%). The per-word
    filter was removed; we now rely on the sentence-level rapid-fire drop +
    the special-token/char-repeat/word-repeat cleanup, which don't fire on
    legitimate words.
    """
    # Mississippi has 4 unique chars out of 11 — would have been flagged.
    text = "I live in Mississippi"
    results = make_results([(text, 0.0, 2.0)])
    parsed = m.parse_canary_output(results, audio_duration=10.0)
    joined = " ".join(c["text"] for c in parsed["chunks"])
    assert "Mississippi" in joined, f"Mississippi dropped: {joined!r}"


def test_isWordLevelChunks_heuristic_triggers():
    """After word-split, ≥82% of chunks must be single words so the frontend's
    normalizeSegments picks the Whisper-style word-level pipeline."""
    # 4 multi-word sentences → 3+2+3+2 = 10 single-word chunks. 100% > 82%.
    results = make_results([
        ("alpha beta gamma", 0, 3),
        ("delta epsilon", 3, 6),
        ("zeta eta theta", 6, 9),
        ("iota kappa", 9, 12),
    ])
    parsed = m.parse_canary_output(results, audio_duration=15.0)
    text_chunks = [c["text"].strip() for c in parsed["chunks"] if c["text"].strip()]
    single_word = [t for t in text_chunks if " " not in t]
    ratio = len(single_word) / len(text_chunks)
    assert ratio > 0.82, f"{ratio:.0%} single-word, need > 82%"


def test_sentence_duration_floor_prevents_zero_duration():
    """If start==end accidentally, max(0.05, ...) prevents divide-by-zero.
    The two words get ~0.025s each, all within the floor window.
    Note: we don't clamp the last word (avoids negative-duration chunks in
    this floored edge case).
    """
    results = make_results([("ab cd", 5.0, 5.0)])  # pathological zero duration
    parsed = m.parse_canary_output(results, audio_duration=10.0)
    # sentence_duration floored to 0.05s; 2 words of equal char-count get 0.025s each
    assert parsed["chunks"][0]["timestamp"][0] == 5.0
    assert math.isclose(parsed["chunks"][0]["timestamp"][1], 5.025, abs_tol=1e-9)
    assert math.isclose(parsed["chunks"][1]["timestamp"][0], 5.025, abs_tol=1e-9)
    # Last word's end is proportional (5.05), not clamped to sentence_end=5.0
    # (a clamp would invert the chunk to negative duration).
    assert math.isclose(parsed["chunks"][1]["timestamp"][1], 5.05, abs_tol=1e-9)


# ── Cleanup regexes (previously tested in /tmp/test_cleanup.py) ────────


_CLEAN_CASES = [
    ("<lendotffextl> of color and light from CGMA", "of color and light from CGMA"),
    ("<|endoftext|> lights interacts with color", "lights interacts with color"),
    ("lights, lights, lights, lights, lights", "lights"),
    ("AAAAAAaaaaaaa", "Aa"),
    ("noooo!", "noooo!"),         # 4 o's, under the 5+ char-repeat threshold
    ("ahhhh ok", "ahhhh ok"),     # 4 h's, under threshold
    ("hello world", "hello world"),
    # Regression: legitimate words with repeating bigrams must NOT be
    # collapsed by any internal-syllable regex (would corrupt
    # Mississippi → Missippi, banana → bana, noooo! → noo!, etc.).
    ("Mississippi", "Mississippi"),
    ("banana", "banana"),
    ("looking", "looking"),
    ("interesting", "interesting"),
]


def test_clean_canary_text_user_bug_cases():
    """Regression tests for the model-artifact cleanup the user reported."""
    for inp, want in _CLEAN_CASES:
        got = m._clean_canary_text(inp)
        assert got == want, f"clean({inp!r}) = {got!r}, want {want!r}"


# ── Chunking (no-VAD fixed-size chunks) ───────────────────────────


def test_build_chunk_specs_short_audio_single_spec():
    """Audio under the short threshold → one spec covering everything (no padding)."""
    specs = m.build_chunk_specs(audio_duration=10.0)
    assert specs == [(0.0, 10.0, 0.0, 10.0)]


def test_build_chunk_specs_at_threshold():
    """Audio exactly at the short threshold → still one spec."""
    specs = m.build_chunk_specs(audio_duration=25.0)
    assert len(specs) == 1
    assert specs[0] == (0.0, 25.0, 0.0, 25.0)


def test_build_chunk_specs_padding_truncated_at_audio_end():
    """Padding can't exceed audio boundaries (avoids negative ranges)."""
    specs = m.build_chunk_specs(audio_duration=60.0)
    # Last spec: core [40, 60], padded_start = max(0, 39) = 39, padded_end =
    # min(60, 61) = 60 (clamped to audio end).
    assert specs[-1] == (39.0, 60.0, 40.0, 60.0)


def test_build_chunk_specs_long_audio_fixed_20s_chunks():
    """60s audio → 3 chunks of 20s each, 1s context padding on each side.

    Padding gives Canary acoustic context for boundary words. Deduplication
    happens at the timestamp layer (midpoint-based, see _run_transcription_sync).
    """
    specs = m.build_chunk_specs(audio_duration=60.0)
    assert len(specs) == 3
    assert specs[0] == (0.0, 21.0, 0.0, 20.0)
    assert specs[1] == (19.0, 41.0, 20.0, 40.0)
    assert specs[2] == (39.0, 60.0, 40.0, 60.0)


def test_build_chunk_specs_50s_audio_three_chunks():
    """50s audio → 3 chunks: 0-20, 20-40, 40-50, 1s padding on each side."""
    specs = m.build_chunk_specs(audio_duration=50.0)
    assert len(specs) == 3
    assert specs[0] == (0.0, 21.0, 0.0, 20.0)
    assert specs[1] == (19.0, 41.0, 20.0, 40.0)
    assert specs[2] == (39.0, 50.0, 40.0, 50.0)


def test_build_chunk_specs_skips_short_trailing_tail():
    """Trailing tail < min_chunk_sec is dropped. 20.05s audio: cursor=20
    → core_end=20.05 → 0.05 < 0.1 (min_chunk_sec) → break, no second spec.
    """
    specs = m.build_chunk_specs(audio_duration=20.05)
    assert len(specs) == 1


def test_build_chunk_specs_keeps_audible_trailing_tail():
    """Audible trailing (>= 0.1s) is kept: 40.5s audio → 3 specs (last
    includes the 0.5s tail). With CONTEXT_PAD_SEC=1.0 the tail's padded_end
    is clamped to audio_duration=40.5 instead of overflowing past it."""
    specs = m.build_chunk_specs(audio_duration=40.5)
    assert len(specs) == 3
    # Last spec: core [40, 40.5], padded_start=max(0, 39)=39, padded_end=
    # min(40.5, 41.5)=40.5 (clamped to audio end).
    assert specs[-1] == (39.0, 40.5, 40.0, 40.5)


def test_build_chunk_specs_full_coverage_no_drop():
    """Critical: every second of audio from 0 to duration is covered by
    some spec's core window — no VAD-based skip, so no fragment is lost.
    """
    specs = m.build_chunk_specs(audio_duration=60.0)
    covered_end = 0.0
    for _, _, core_start, core_end in specs:
        assert core_start >= covered_end
        covered_end = core_end
    assert math.isclose(covered_end, 60.0, abs_tol=1e-9)


def test_build_chunk_specs_custom_params():
    """Smaller chunks for testing. 10s audio at 3s per chunk → 4 chunks.

    With context_pad_sec=0.5 the first spec's padded_start is clamped to 0
    and the last spec's padded_end is clamped to audio_duration=10.0.
    """
    specs = m.build_chunk_specs(
        audio_duration=10.0,
        fixed_chunk_sec=3.0,
        context_pad_sec=0.5,
        short_threshold_sec=2.0,
    )
    assert len(specs) == 4
    # specs[0]: padded_start clamped to 0, padded_end = core_end + 0.5 = 3.5
    assert specs[0] == (0.0, 3.5, 0.0, 3.0)
    # specs[1]: standard padding on both sides
    assert specs[1] == (2.5, 6.5, 3.0, 6.0)
    # specs[3]: padded_end clamped to audio_duration=10.0
    assert specs[3] == (8.5, 10.0, 9.0, 10.0)


def test_build_chunk_specs_no_padding_explicit():
    """Setting context_pad_sec=0 still returns valid non-overlapping specs."""
    specs = m.build_chunk_specs(audio_duration=60.0, context_pad_sec=0.0)
    assert specs[0] == (0.0, 20.0, 0.0, 20.0)
    assert specs[1] == (20.0, 40.0, 20.0, 40.0)


# ── Entrypoint for plain `python3 test_parse_canary.py` ──────────────


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = failed = 0
    for t in tests:
        name = t.__name__
        try:
            t()
        except AssertionError as e:
            print(f"  [FAIL] {name}: {e}")
            failed += 1
        else:
            print(f"  [PASS] {name}")
            passed += 1
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
