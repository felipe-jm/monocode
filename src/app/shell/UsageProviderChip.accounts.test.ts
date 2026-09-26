// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRateLimits } from "../../features/providers/model/rateLimits";
import type { ProviderAccount } from "../../features/providers/model/providerAccounts";
import { UsageProviderChip } from "./UsageProviderChip";

const identities: Record<string, { email: string }> = {
  "claude:default": { email: "devs3@example.com" },
  "claude:a1": { email: "devs@example.com" },
};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (_cmd: string, args: { provider: string; accountId: string }) =>
    identities[`${args.provider}:${args.accountId}`] ?? null,
  ),
}));

const now = Date.parse("2026-09-16T12:00:00Z");
function limits(provider: ProviderRateLimits["provider"], session: number): ProviderRateLimits {
  return {
    provider,
    session: { usedPercent: session, windowMinutes: 300, resetsAt: now + 3_600_000 },
    weekly: { usedPercent: 50, windowMinutes: 10_080, resetsAt: now + 86_400_000 },
    monthly: null,
    resetCredits: null,
    updatedAt: now,
    error: null,
    status: "ok",
  };
}

vi.mock("../../features/providers/model/rateLimitsFetch", () => ({
  fetchClaudeRateLimits: vi.fn(async (accountId: string) =>
    accountId === "a1"
      ? limits("claude", 71)
      : {
          ...limits("claude", 0),
          session: null,
          weekly: null,
          status: "error",
          error: "Token expired",
        },
  ),
  fetchCodexRateLimits: vi.fn(async () => limits("codex", 12)),
}));

const accounts: ProviderAccount[] = [
  { id: "default", provider: "claude", label: "Devs 3" },
  { id: "a1", provider: "claude", label: "Devs" },
  { id: "default", provider: "codex", label: "Default account" },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("UsageProviderChip all accounts", () => {
  it("lists every profile under the omp popover, omp's account first, one failure isolated", async () => {
    const omp = {
      ...limits("omp", 6),
      account: { provider: "claude" as const, email: "DEVS@example.com" },
    };
    await act(async () =>
      root.render(createElement(UsageProviderChip, { limits: omp, now, allAccounts: accounts })),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="omp usage details"]')!.click(),
    );
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-account-usage="codex:default"]')?.textContent,
      ).toContain("12%"),
    );

    expect(document.body.textContent).toContain("omp account · DEVS@example.com");
    const rows = [...document.querySelectorAll<HTMLElement>("[data-account-usage]")];
    expect(rows.map((row) => row.dataset.accountUsage)).toEqual([
      "claude:a1",
      "claude:default",
      "codex:default",
    ]);
    expect(rows[0].textContent).toContain("in use");
    expect(rows[0].textContent).toContain("71%");
    expect(rows[1].textContent).toContain("Token expired");
  });
});
