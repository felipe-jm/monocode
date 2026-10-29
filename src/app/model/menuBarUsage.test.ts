import { describe, expect, it } from "vitest";
import {
  errorRateLimits,
  type ProviderRateLimits,
  type RateLimitWindow,
} from "../../features/providers/model/rateLimits";
import { menuBarUsageSections } from "./menuBarUsage";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const HOUR = 60 * 60_000;

function windowOf(
  usedPercent: number,
  windowMinutes: number,
  resetsIn: number | null,
): RateLimitWindow {
  return {
    usedPercent,
    windowMinutes,
    resetsAt: resetsIn == null ? null : NOW + resetsIn,
  };
}

function limits(overrides: Partial<ProviderRateLimits>): ProviderRateLimits {
  return {
    provider: "claude",
    session: null,
    weekly: null,
    monthly: null,
    resetCredits: null,
    updatedAt: NOW,
    error: null,
    status: "ok",
    ...overrides,
  };
}

describe("menuBarUsageSections", () => {
  it("colors each Claude window like the Settings meters and explains accounts without data", () => {
    const [claude] = menuBarUsageSections({
      claudeAccounts: [
        { id: "work", provider: "claude", label: "Work" },
        { id: "old", provider: "claude", label: "Old" },
      ],
      claudeUsage: {
        "claude:work": limits({
          session: windowOf(79, 300, 2 * HOUR),
          weekly: windowOf(85, 10_080, 3 * 24 * HOUR),
          monthly: windowOf(100, 43_200, 20 * 24 * HOUR),
        }),
        "claude:old": errorRateLimits("claude", "Claude sign-in expired"),
      },
      claudeUpdatedAt: NOW,
      omp: null,
      now: NOW,
    });

    expect(claude.title).toBe("Claude");
    expect(claude.note).toMatch(/^Updated /);
    const [work, old] = claude.accounts;
    expect(work.detail).toBeNull();
    expect(
      work.meters.map(({ value, percent, tone }) => [value, percent, tone]),
    ).toEqual([
      ["79%", 79, "ok"],
      ["85%", 85, "warn"],
      ["Full", 100, "critical"],
    ]);
    expect(work.meters.map((meter) => meter.caption.split(" · ")[0])).toEqual([
      "5h",
      "Weekly",
      "Monthly",
    ]);
    expect(old).toEqual({
      title: "Old",
      detail: "Claude sign-in expired",
      meters: [],
    });
  });

  it("does not call a used-up window full once its reset time has passed", () => {
    const [claude] = menuBarUsageSections({
      claudeAccounts: [{ id: "default", provider: "claude", label: "Default" }],
      claudeUsage: {
        "claude:default": limits({ session: windowOf(100, 300, -HOUR) }),
      },
      claudeUpdatedAt: NOW,
      omp: null,
      now: NOW,
    });
    expect(claude.accounts[0].meters[0]).toMatchObject({
      caption: "5h · reset due",
      value: "100%",
    });
  });

  it("lists every omp account by provider and email, and omp failures in place of meters", () => {
    const anthropic = limits({
      provider: "omp",
      accountEmail: "devs@example.com",
      weekly: windowOf(80, 10_080, 2 * 24 * HOUR),
    });
    const codex = limits({
      provider: "omp",
      monthly: windowOf(70, 43_200, 20 * 24 * HOUR),
    });
    const sections = menuBarUsageSections({
      claudeAccounts: [],
      claudeUsage: {},
      claudeUpdatedAt: null,
      omp: {
        reports: [
          { provider: "anthropic", limits: anthropic },
          { provider: "openai-codex", limits: codex },
          { provider: "google", limits: limits({ provider: "omp" }) },
        ],
        updatedAt: NOW,
      },
      now: NOW,
    });
    expect(sections.map((section) => section.title)).toEqual(["omp"]);
    expect(
      sections[0].accounts.map(({ title, detail, meters }) => [
        title,
        detail,
        meters.map((meter) => meter.tone),
      ]),
    ).toEqual([
      ["Claude · devs@example.com", null, ["warn"]],
      ["Codex", null, ["ok"]],
      ["google", "No usage limits reported", []],
    ]);

    const [failed] = menuBarUsageSections({
      claudeAccounts: [],
      claudeUsage: {},
      claudeUpdatedAt: null,
      omp: { error: "omp usage timed out" },
      now: NOW,
    });
    expect(failed).toEqual({
      title: "omp",
      note: null,
      accounts: [{ title: "omp", detail: "omp usage timed out", meters: [] }],
    });
  });
});
