import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UsageFooter } from "./UsageFooter";

describe("UsageFooter terminal control", () => {
  it("replaces the generic terminal button with the live process control", () => {
    const markup = renderToStaticMarkup(
      createElement(UsageFooter, {
        providers: [],
        terminals: [
          {
            id: "terminal-1",
            process: "npm",
            cwd: "/repo",
            label: "repo",
          },
        ],
        terminalOpen: true,
        onToggleTerminal: vi.fn(),
        onNewTerminal: vi.fn(),
        onShowTerminal: vi.fn(),
        projectTerminalActive: true,
      }),
    );

    expect(markup).toContain(">npm</span>");
    expect(markup).not.toContain(">Terminal</span>");
    expect(markup.match(/<button/g)).toHaveLength(1);
  });

  it("keeps the generic terminal button when no process is running", () => {
    const markup = renderToStaticMarkup(
      createElement(UsageFooter, {
        providers: [],
        onNewTerminal: vi.fn(),
      }),
    );

    expect(markup).toContain(">Terminal</span>");
    expect(markup.match(/<button/g)).toHaveLength(1);
  });
});

describe("UsageFooter session git chips", () => {
  const pr = (repo: string, number: number) => ({
    repo,
    number,
    url: `https://github.com/${repo}/pull/${number}`,
  });

  it("shows the newest branches and PRs and counts the rest", () => {
    const markup = renderToStaticMarkup(
      createElement(UsageFooter, {
        providers: [],
        git: {
          branches: ["feat/a", "feat/b", "feat/c"],
          pullRequests: [pr("acme/app", 7)],
        },
      }),
    );

    expect(markup).not.toContain(">feat/a</span>");
    expect(markup).toContain(">feat/b</span>");
    expect(markup).toContain(">feat/c</span>");
    expect(markup).toContain('aria-label="Open PR acme/app#7"');
    expect(markup).toContain(">#7</span>");
    expect(markup).toContain(">+1</button>");
  });

  it("names the repo on PRs only when several repos are involved", () => {
    const markup = renderToStaticMarkup(
      createElement(UsageFooter, {
        providers: [],
        git: {
          branches: [],
          pullRequests: [pr("acme/frontend", 12), pr("acme/backend", 30)],
        },
      }),
    );

    expect(markup).toContain(">frontend#12</span>");
    expect(markup).toContain(">backend#30</span>");
    expect(markup).not.toContain("Show all");
  });

  it("renders nothing when the session created no branch or PR", () => {
    const markup = renderToStaticMarkup(
      createElement(UsageFooter, {
        providers: [],
        git: { branches: [], pullRequests: [] },
      }),
    );

    expect(markup).not.toContain("Session branches and pull requests");
  });
});
