import type { AgentModel } from "../../../../features/sessions/model/models";

// Whole words only: `gemini` must not read as `mini`, nor `minimax` as cheap.
const CHEAP = /(^|[^a-z])(haiku|mini|flash|nano|lite|luna)([^a-z]|$)/i;
const DATE_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;
// Parameter counts such as `14b` or `135m` size a model; they do not version it.
const SIZE_TOKEN = /^\d+[bm]$/i;

function versionKey(nativeId: string): { version: number[]; dated: boolean } {
  const bare = nativeId.slice(nativeId.indexOf("/") + 1);
  const dated = DATE_SUFFIX.test(bare);
  const version = bare
    .replace(DATE_SUFFIX, "")
    .split(/[^a-z0-9]+/i)
    .filter((token) => !SIZE_TOKEN.test(token))
    .flatMap((token) => token.match(/\d+/g) ?? [])
    // Four or more digits is a year or build stamp, not a version.
    .filter((digits) => digits.length < 4)
    .map(Number);
  return { version, dated };
}

function compareNewestFirst(a: string, b: string): number {
  const left = versionKey(a);
  const right = versionKey(b);
  const length = Math.max(left.version.length, right.version.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (right.version[i] ?? 0) - (left.version[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return Number(left.dated) - Number(right.dated);
}

/** Text-model candidates, best first. Empty means "let the CLI pick". */
export function rankPiTextModels(models: AgentModel[], requested?: string): string[] {
  const selected = requested?.trim();
  if (selected?.includes("/")) return [selected];
  const ids = models
    .map((model) => ({ model, id: model.nativeId?.trim() ?? "" }))
    .filter(({ id }) => id.includes("/"));
  const cheap = ids
    .filter(({ model, id }) => CHEAP.test(`${id} ${model.name} ${model.id}`))
    .map(({ id }) => id)
    .sort(compareNewestFirst);
  if (cheap.length > 0) return cheap;
  return ids.length > 0 ? [ids[0].id] : [];
}

/** A text-prompt failure tagged with the model that produced it. */
export class TextModelError extends Error {
  readonly model: string | undefined;
  readonly failure: unknown;

  constructor(model: string | undefined, failure: unknown) {
    super(failure instanceof Error ? failure.message : String(failure));
    this.name = "TextModelError";
    this.model = model;
    this.failure = failure;
  }
}

/** The model a text-prompt failure came from, when the error records it. */
export function failedTextModel(error: unknown): string | undefined {
  return error instanceof TextModelError ? error.model : undefined;
}

/**
 * Try the first candidate; on a retryable failure try the next one once.
 * The final failure is rethrown as a `TextModelError` naming its model.
 */
export async function runWithFallback<T>(
  candidates: (string | undefined)[],
  attempt: (model: string | undefined) => Promise<T>,
  retryable: (error: unknown) => boolean,
): Promise<T> {
  const [first, second] = candidates.length > 0 ? candidates : [undefined];
  try {
    return await attempt(first);
  } catch (error) {
    if (candidates.length < 2 || !retryable(error)) throw new TextModelError(first, error);
    console.warn("[monocode] text model failed, retrying", first, "->", second, error);
  }
  try {
    return await attempt(second);
  } catch (error) {
    throw new TextModelError(second, error);
  }
}
