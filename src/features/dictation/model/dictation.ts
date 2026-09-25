import { invoke } from "@tauri-apps/api/core";

const MODEL_KEY = "monocode.dictationModel";
const LANGUAGE_KEY = "monocode.dictationLanguage";
const GLOSSARY_KEY = "monocode.dictationGlossary";
const CORRECTIONS_KEY = "monocode.dictationCorrections";

export const DICTATION_LANGUAGE_DEFAULT = "auto";
/** Whisper forgets an initial prompt past ~224 tokens; keep it well under. */
export const DICTATION_PROMPT_MAX = 480;
/** Fired on `window` whenever a dictation setting changes. */
export const DICTATION_SETTINGS_CHANGE_EVENT = "monocode:dictation-change";
export const DICTATION_SAMPLE_RATE = 16_000;
/** Same cap as the native side, so a long take is sent rather than lost. */
export const DICTATION_MAX_SECONDS = 600;

export type DictationSettings = {
  model: string | null;
  language: string;
  glossary: string;
  corrections: string;
};

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // private mode / quota
  }
}

export function loadDictationSettings(): DictationSettings {
  return {
    model: read(MODEL_KEY)?.trim() || null,
    language: read(LANGUAGE_KEY)?.trim() || DICTATION_LANGUAGE_DEFAULT,
    glossary: read(GLOSSARY_KEY) ?? "",
    corrections: read(CORRECTIONS_KEY) ?? "",
  };
}

export function saveDictationSettings(patch: Partial<DictationSettings>) {
  if ("model" in patch) write(MODEL_KEY, patch.model?.trim() ?? "");
  if ("language" in patch) write(LANGUAGE_KEY, patch.language?.trim() ?? "");
  if ("glossary" in patch) write(GLOSSARY_KEY, patch.glossary ?? "");
  if ("corrections" in patch) write(CORRECTIONS_KEY, patch.corrections ?? "");
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(DICTATION_SETTINGS_CHANGE_EVENT));
}

export function subscribeDictationSettings(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(DICTATION_SETTINGS_CHANGE_EVENT, onStoreChange);
  return () =>
    window.removeEventListener(DICTATION_SETTINGS_CHANGE_EVENT, onStoreChange);
}

/**
 * One term per line becomes whisper's initial prompt. Past the limit the
 * tail is dropped whole, so put the terms that matter most first.
 */
export function glossaryPrompt(glossary: string): string {
  let prompt = "";
  for (const line of glossary.split("\n")) {
    const term = line.trim();
    if (!term || term.startsWith("#")) continue;
    const next = prompt ? `${prompt}, ${term}` : term;
    if (next.length > DICTATION_PROMPT_MAX) break;
    prompt = next;
  }
  return prompt;
}

type Correction = { pattern: RegExp; replacement: string };

/** `wrong => right` per line; matches whole words, ignoring case. */
function parseCorrections(corrections: string): Correction[] {
  const out: Correction[] = [];
  for (const line of corrections.split("\n")) {
    if (line.trim().startsWith("#")) continue;
    const arrow = line.indexOf("=>");
    if (arrow < 0) continue;
    const wrong = line.slice(0, arrow).trim();
    const right = line.slice(arrow + 2).trim();
    if (!wrong) continue;
    const literal = wrong.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out.push({
      pattern: new RegExp(
        `(?<![\\p{L}\\p{N}])${literal}(?![\\p{L}\\p{N}])`,
        "giu",
      ),
      replacement: right,
    });
  }
  return out;
}

export function applyCorrections(text: string, corrections: string): string {
  return parseCorrections(corrections).reduce(
    (current, { pattern, replacement }) =>
      current.replace(pattern, () => replacement),
    text,
  );
}

export async function transcribeDictation(
  samples: Float32Array,
  settings: DictationSettings,
): Promise<string> {
  if (!settings.model) throw new Error("Choose a dictation model in Settings.");
  const options = new URLSearchParams({
    model: settings.model,
    language: settings.language,
    prompt: glossaryPrompt(settings.glossary),
  });
  // The timer stops a take at the cap, but the resampled length can run a frame over.
  const take = samples.subarray(
    0,
    DICTATION_SAMPLE_RATE * DICTATION_MAX_SECONDS,
  );
  const bytes = new Uint8Array(take.buffer, take.byteOffset, take.byteLength);
  const text = await invoke<string>("dictation_transcribe", bytes, {
    headers: { "x-dictation": options.toString() },
  });
  return applyCorrections(text, settings.corrections);
}
