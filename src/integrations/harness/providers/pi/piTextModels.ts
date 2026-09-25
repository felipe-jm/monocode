import type { AgentModel } from "../../../../features/sessions/model/models";

const CHEAP = /haiku|mini|flash|nano|lite|luna/i;
const DATE_SUFFIX = /-\d{8}$/;

function versionKey(nativeId: string): { version: number[]; dated: boolean } {
  const bare = nativeId.slice(nativeId.indexOf("/") + 1);
  const dated = DATE_SUFFIX.test(bare);
  const version = (bare.replace(DATE_SUFFIX, "").match(/\d+/g) ?? []).map(Number);
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

/** Try the first candidate; on a retryable failure try the next one once. */
export async function runWithFallback<T>(
  candidates: (string | undefined)[],
  attempt: (model: string | undefined) => Promise<T>,
  retryable: (error: unknown) => boolean,
): Promise<T> {
  const [first, second] = candidates.length > 0 ? candidates : [undefined];
  try {
    return await attempt(first);
  } catch (error) {
    if (candidates.length < 2 || !retryable(error)) throw error;
    console.warn("[monocode] text model failed, retrying", first, error);
    return attempt(second);
  }
}
