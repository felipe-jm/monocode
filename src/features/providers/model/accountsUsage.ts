import { useEffect, useRef, useState } from "react";
import type { ProviderAccount } from "./providerAccounts";
import { identityKey } from "./providerAccountIdentity";
import {
  isRateLimitSnapshotStale,
  type OmpUsageAccount,
  type ProviderRateLimits,
  type RateLimitProvider,
} from "./rateLimits";
import { fetchClaudeRateLimits, fetchCodexRateLimits } from "./rateLimitsFetch";

/** Which account the open usage chip is showing. */
export type ActiveUsageAccount = {
  chip: RateLimitProvider;
  /** Claude/Codex chips: the MonoCode profile id. */
  accountId?: string;
  /** omp chip: the account omp itself read usage from. */
  ompAccount?: OmpUsageAccount;
};

export type AccountUsageRow = {
  account: ProviderAccount;
  email: string | null;
  inUse: boolean;
};

export function isAccountInUse(
  account: ProviderAccount,
  email: string | null | undefined,
  active: ActiveUsageAccount,
): boolean {
  if (active.chip === "omp") {
    const omp = active.ompAccount;
    return Boolean(
      omp?.email &&
        email &&
        omp.provider === account.provider &&
        omp.email.toLowerCase() === email.toLowerCase(),
    );
  }
  return active.chip === account.provider && active.accountId === account.id;
}

/** Every profile, the one in use first; the rest keep their given order. */
export function accountUsageRows(
  accounts: ProviderAccount[],
  emails: Record<string, string | null | undefined>,
  active: ActiveUsageAccount,
): AccountUsageRow[] {
  const rows = accounts.map((account) => {
    const email = emails[identityKey(account)] ?? null;
    return { account, email, inUse: isAccountInUse(account, email, active) };
  });
  return [...rows.filter((row) => row.inUse), ...rows.filter((row) => !row.inUse)];
}

const cache = new Map<string, ProviderRateLimits>();

async function fetchAccountUsage(
  account: ProviderAccount,
): Promise<ProviderRateLimits> {
  const key = identityKey(account);
  const cached = cache.get(key);
  if (cached && !isRateLimitSnapshotStale(cached, Date.now())) return cached;
  const value =
    account.provider === "claude"
      ? await fetchClaudeRateLimits(account.id)
      : await fetchCodexRateLimits(account.id);
  cache.set(key, value);
  return value;
}

/**
 * Usage of every profile while `enabled` (the popover is open). Snapshots are
 * cached for the usual refetch interval, so reopening the popover is free.
 */
export function useAccountsUsage(
  accounts: ProviderAccount[],
  enabled: boolean,
): Record<string, ProviderRateLimits | undefined> {
  const [usage, setUsage] = useState<Record<string, ProviderRateLimits>>(() =>
    Object.fromEntries(
      accounts.flatMap((account) => {
        const hit = cache.get(identityKey(account));
        return hit ? [[identityKey(account), hit]] : [];
      }),
    ),
  );
  const key = accounts.map(identityKey).join("|");

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    for (const account of accounts) {
      void fetchAccountUsage(account).then((value) => {
        if (!cancelled) {
          setUsage((current) => ({ ...current, [identityKey(account)]: value }));
        }
      });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return usage;
}
