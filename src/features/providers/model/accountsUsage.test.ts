import { describe, expect, it } from "vitest";
import type { ProviderAccount } from "./providerAccounts";
import { accountUsageRows, isAccountInUse } from "./accountsUsage";

const claude = (id: string, label: string): ProviderAccount => ({
  id,
  provider: "claude",
  label,
});
const codex: ProviderAccount = { id: "default", provider: "codex", label: "Default account" };
const accounts = [claude("default", "Devs 3"), claude("a2", "Devs 2"), claude("a1", "Devs"), codex];
const emails = {
  "claude:default": "devs3@example.com",
  "claude:a2": "devs2@example.com",
  "claude:a1": "devs@example.com",
  "codex:default": "felipe@example.com",
};

describe("isAccountInUse", () => {
  it("matches the chip's own account by id", () => {
    const active = { chip: "claude" as const, accountId: "a2" };
    expect(isAccountInUse(accounts[1], null, active)).toBe(true);
    expect(isAccountInUse(accounts[0], null, active)).toBe(false);
    expect(isAccountInUse(codex, null, { chip: "codex", accountId: "a2" })).toBe(false);
  });

  it("matches omp's account by provider and email, ignoring case", () => {
    const active = {
      chip: "omp" as const,
      ompAccount: { provider: "claude" as const, email: "DEVS2@example.com" },
    };
    expect(isAccountInUse(accounts[1], "devs2@example.com", active)).toBe(true);
    expect(isAccountInUse(accounts[0], "devs3@example.com", active)).toBe(false);
    // Same email on another provider is a different account.
    expect(
      isAccountInUse(codex, "devs2@example.com", active),
    ).toBe(false);
  });

  it("marks nothing when omp reports no email", () => {
    const active = { chip: "omp" as const, ompAccount: { provider: "claude" as const, email: null } };
    expect(isAccountInUse(accounts[0], null, active)).toBe(false);
  });
});

describe("accountUsageRows", () => {
  it("puts the account in use first and keeps the rest in provider order", () => {
    const rows = accountUsageRows(accounts, emails, {
      chip: "omp",
      ompAccount: { provider: "claude", email: "devs@example.com" },
    });
    expect(rows.map((row) => [row.account.label, row.inUse])).toEqual([
      ["Devs", true],
      ["Devs 3", false],
      ["Devs 2", false],
      ["Default account", false],
    ]);
    expect(rows[0].email).toBe("devs@example.com");
  });
});
