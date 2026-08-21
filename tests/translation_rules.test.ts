import { describe, it, expect } from "vitest"
import { MARIAN_TRANSLATION_MODELS, TRANSLATION_MODEL, LANGS } from "@/scripts/languages.ts"

const BRACKETED_SOUND_TRANSLATIONS: Record<string, Record<string, string>> = {
  es: {
    APPLAUSE: "APLAUSOS",
    CLAPPING: "APLAUSOS",
    LAUGHTER: "RISAS",
    LAUGHING: "RISAS",
    MUSIC: "MUSICA",
    CHEERING: "VITORES",
    SILENCE: "SILENCIO",
    NOISE: "RUIDO",
    "BACKGROUND NOISE": "RUIDO DE FONDO",
    INAUDIBLE: "INAUDIBLE",
    SIGH: "SUSPIRO",
    COUGH: "TOS",
    COUGHING: "TOS",
    CRYING: "LLANTO",
    GASP: "JADEO",
    BEEP: "PITIDO",
    WHISTLE: "SILBIDO",
  },
}

const BRACKETED_CUE_PATTERN = /\[([^\[\]]{1,80})\]/g

function translateBracketedSoundCues(text: string, targetLang: string) {
  const glossary = BRACKETED_SOUND_TRANSLATIONS[targetLang]
  if (!glossary) return text

  return text.replace(BRACKETED_CUE_PATTERN, (match, label) => {
    const key = label.trim().toUpperCase()
    const translated = glossary[key]
    return translated ? `[${translated}]` : match
  })
}

function resolveBackendForPair(source: string, target: string): "marian" | "nllb" {
  const key = `${source}:${target}`
  return MARIAN_TRANSLATION_MODELS[key] ? "marian" : "nllb"
}

describe("Translation Rules & Routing Suite", () => {
  it("translates bracketed audio/sound descriptions correctly into Spanish", () => {
    expect(translateBracketedSoundCues("[APPLAUSE] Thank you everyone!", "es")).toBe("[APLAUSOS] Thank you everyone!")
    expect(translateBracketedSoundCues("It was hilarious [LAUGHTER]", "es")).toBe("It was hilarious [RISAS]")
    expect(translateBracketedSoundCues("[MUSIC] Theme playing [MUSIC]", "es")).toBe("[MUSICA] Theme playing [MUSICA]")
  })

  it("leaves untranslated unknown or unlisted sound cues intact", () => {
    expect(translateBracketedSoundCues("[CUSTOM_SOUND] Unchanged", "es")).toBe("[CUSTOM_SOUND] Unchanged")
  })

  it("selects lightweight MarianMT models for common language pairs", () => {
    expect(resolveBackendForPair("en", "es")).toBe("marian")
    expect(resolveBackendForPair("es", "en")).toBe("marian")
    expect(resolveBackendForPair("en", "fr")).toBe("marian")
    expect(resolveBackendForPair("en", "de")).toBe("marian")
    expect(resolveBackendForPair("en", "it")).toBe("marian")
    expect(resolveBackendForPair("en", "pt")).toBe("marian")
    expect(resolveBackendForPair("en", "ru")).toBe("marian")
  })

  it("routes rare or unsupported pairs to universal NLLB-200 model", () => {
    expect(resolveBackendForPair("zh", "es")).toBe("nllb")
    expect(resolveBackendForPair("ja", "es")).toBe("nllb")
    expect(resolveBackendForPair("ar", "hi")).toBe("nllb")
  })

  it("has valid NLLB language tags for all 16 supported languages", () => {
    for (const [code, info] of Object.entries(LANGS)) {
      expect(info.label).toBeDefined()
      expect(info.nllb).toMatch(/^[a-z]{3}_[A-Za-z]{4}$/)
    }
  })
})
