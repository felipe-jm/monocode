import { describe, expect, it, vi } from "vitest";
import type { AgentModel } from "../../../../features/sessions/model/models";
import { rankPiTextModels, runWithFallback } from "./piTextModels";

const m = (nativeId: string, name = nativeId): AgentModel => ({
  id: `omp:${nativeId}`,
  harness: "omp",
  name,
  nativeId,
});

describe("rankPiTextModels", () => {
  it("prefers the newest cheap model over an older dated snapshot", () => {
    const catalog = [
      m("anthropic/claude-3-haiku-20240307", "Claude Haiku 3"),
      m("anthropic/claude-haiku-4-5-20251001", "Claude Haiku 4.5 (20251001)"),
      m("anthropic/claude-haiku-4-5", "Claude Haiku 4.5"),
      m("anthropic/claude-opus-5-5", "Claude Opus 5.5"),
    ];
    expect(rankPiTextModels(catalog)).toEqual([
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-haiku-4-5-20251001",
      "anthropic/claude-3-haiku-20240307",
    ]);
  });

  it("keeps an explicit provider/model request", () => {
    expect(rankPiTextModels([m("a/haiku-9")], "x/custom")).toEqual(["x/custom"]);
  });

  it("falls back to the first catalog model when nothing is cheap", () => {
    expect(rankPiTextModels([m("a/opus-5"), m("a/sonnet-5")])).toEqual(["a/opus-5"]);
  });

  it("returns [] for an empty catalog", () => {
    expect(rankPiTextModels([])).toEqual([]);
  });
});

describe("runWithFallback", () => {
  it("retries once with the next candidate on a retryable error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error("404 not_found_error"))
      .mockResolvedValueOnce("OK");
    await expect(runWithFallback(["a", "b", "c"], attempt, () => true)).resolves.toBe("OK");
    expect(attempt.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
  });

  it("does not retry a non-retryable error", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error("timed out"));
    await expect(runWithFallback(["a", "b"], attempt, () => false)).rejects.toThrow("timed out");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("stops after one retry", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const attempt = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(runWithFallback(["a", "b", "c"], attempt, () => true)).rejects.toThrow("boom");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("runs once with undefined when there are no candidates", async () => {
    const attempt = vi.fn().mockResolvedValue("OK");
    await runWithFallback([], attempt, () => true);
    expect(attempt).toHaveBeenCalledWith(undefined);
  });
});
