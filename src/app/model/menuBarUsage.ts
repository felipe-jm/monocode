import { accountStatus } from "../../features/providers/model/accountUsage";
import {
  clampUsedPercent,
  formatUsagePercent,
  type OmpUsageReport,
  type ProviderRateLimits,
  type RateLimitWindow,
} from "../../features/providers/model/rateLimits";
import type { ProviderAccount } from "../../features/providers/model/providerAccounts";
import { identityKey } from "../../features/providers/model/providerAccountIdentity";
import { meterWindows } from "../../features/providers/ui/ProviderAccountUsage";

/** Same cut-offs as the Settings and footer meters (`barClass`). */
export type MenuBarUsageTone = "ok" | "warn" | "critical";

export type MenuBarUsageMeter = {
  /** "5h · 16:40": window and when it resets. */
  caption: string;
  /** "20%" or "Full". */
  value: string;
  percent: number;
  tone: MenuBarUsageTone;
};

export type MenuBarUsageAccount = {
  title: string;
  /** Why there are no meters, e.g. "Claude sign-in expired". */
  detail: string | null;
  meters: MenuBarUsageMeter[];
};

export type MenuBarUsageSection = {
  title: string;
  /** "Updated 14:32". */
  note: string | null;
  accounts: MenuBarUsageAccount[];
};

export type MenuBarOmpUsage =
  | { reports: OmpUsageReport[]; updatedAt: number }
  | { error: string };

const OMP_PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Claude",
  "openai-codex": "Codex",
};

/**
 * The usage sections of the Mono menu: the Claude accounts MonoCode signs in
 * with, then every account omp reports. Strings are final; the native menu
 * only lays them out, so its text is fixed between refreshes and says when
 * windows reset as a clock time rather than a countdown that would go stale.
 */
export function menuBarUsageSections({
  claudeAccounts,
  claudeUsage,
  claudeUpdatedAt,
  omp,
  now,
}: {
  claudeAccounts: ProviderAccount[];
  claudeUsage: Record<string, ProviderRateLimits>;
  claudeUpdatedAt: number | null;
  /** Null when omp is not installed. */
  omp: MenuBarOmpUsage | null;
  now: number;
}): MenuBarUsageSection[] {
  const sections: MenuBarUsageSection[] = [];
  if (claudeAccounts.length > 0) {
    sections.push({
      title: "Claude",
      note: updatedNote(claudeUpdatedAt),
      accounts: claudeAccounts.map((account) => {
        const limits = claudeUsage[identityKey(account)];
        return usageAccount(
          account.label,
          limits,
          accountStatus(limits, now).label,
          now,
        );
      }),
    });
  }
  if (omp) {
    sections.push(
      "error" in omp
        ? {
            title: "omp",
            note: null,
            accounts: [{ title: "omp", detail: omp.error, meters: [] }],
          }
        : {
            title: "omp",
            note: updatedNote(omp.updatedAt),
            accounts:
              omp.reports.length > 0
                ? omp.reports.map((report) => {
                    const name =
                      OMP_PROVIDER_NAMES[report.provider] ?? report.provider;
                    const email = report.limits.accountEmail;
                    return usageAccount(
                      email ? `${name} · ${email}` : name,
                      report.limits,
                      "No usage limits reported",
                      now,
                    );
                  })
                : [
                    {
                      title: "omp",
                      detail: "No signed-in accounts",
                      meters: [],
                    },
                  ],
          },
    );
  }
  return sections;
}

function usageAccount(
  title: string,
  limits: ProviderRateLimits | undefined,
  emptyDetail: string,
  now: number,
): MenuBarUsageAccount {
  const meters = meterWindows(limits).map(({ title: label, window }) =>
    usageMeter(label, window, now),
  );
  return { title, detail: meters.length > 0 ? null : emptyDetail, meters };
}

function usageMeter(
  label: string,
  window: RateLimitWindow,
  now: number,
): MenuBarUsageMeter {
  const percent = clampUsedPercent(window.usedPercent);
  const reset = resetLabel(window.resetsAt, now);
  return {
    caption: reset ? `${label} · ${reset}` : label,
    value:
      percent >= 100 && (window.resetsAt == null || window.resetsAt > now)
        ? "Full"
        : formatUsagePercent(percent),
    percent,
    tone: percent >= 90 ? "critical" : percent >= 80 ? "warn" : "ok",
  };
}

const DAY_MS = 24 * 60 * 60_000;

/** "16:40" today, "Fri 09:00" this week, "Nov 27" further out. */
function resetLabel(resetsAt: number | null, now: number): string | null {
  if (resetsAt == null) return null;
  if (resetsAt <= now) return "reset due";
  const date = new Date(resetsAt);
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (resetsAt - now < DAY_MS) return time;
  if (resetsAt - now < 7 * DAY_MS) {
    return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function updatedNote(updatedAt: number | null): string | null {
  return updatedAt == null
    ? null
    : `Updated ${new Date(updatedAt).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      })}`;
}
