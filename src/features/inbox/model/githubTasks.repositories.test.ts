import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInboxCache,
  githubPrDiff,
  githubRepositories,
  githubWorkItemComment,
  githubWorkItemDetails,
  githubWorkItemThread,
  inboxRepoPath,
  listInboxItems,
  peekGithubWorkItemDetails,
  projectRepositories,
  type GithubWorkItem,
} from "./githubTasks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  clearInboxCache();
  vi.mocked(invoke).mockReset();
});

function workItem(repo: string, kind: "issue" | "pr"): GithubWorkItem {
  return {
    kind,
    number: 10,
    title: `${repo} item`,
    url: `https://github.com/${repo}/${kind === "pr" ? "pull" : "issues"}/10`,
    state: "open",
    updatedAt: "2026-09-16T08:00:00Z",
    labels: [],
    assignees: [],
    draft: false,
    repo,
  };
}

describe("GitHub fork repositories", () => {
  it("caches the local repository and parent metadata", async () => {
    vi.mocked(invoke).mockResolvedValue(["maya/web", "acme/web"] as never);

    await expect(githubRepositories("/tmp/web")).resolves.toEqual([
      "maya/web",
      "acme/web",
    ]);
    await expect(githubRepositories("/tmp/web/")).resolves.toEqual([
      "maya/web",
      "acme/web",
    ]);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("git_github_repositories", {
      cwd: "/tmp/web",
    });
  });

  it("fetches a shared parent once and keeps the preferred local checkout", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const input = args as Record<string, unknown> | undefined;
      if (command === "git_project_repositories") {
        return [String((args as { cwd: string }).cwd)] as never;
      }
      if (command === "git_github_repositories") {
        return (
          input?.cwd === "/tmp/fork-a"
            ? ["maya/web", "acme/web"]
            : ["lin/web", "ACME/web"]
        ) as never;
      }
      if (command === "git_github_work_items") {
        const repo = String(input?.repo ?? "");
        const kind = input?.kind as "issue" | "pr";
        return (
          repo.toLowerCase() === "acme/web" && kind === "issue"
            ? [workItem("acme/web", kind)]
            : []
        ) as never;
      }
      if (
        command === "linear_status" ||
        command === "jira_status" ||
        command === "gitlab_status" ||
        command === "azure_devops_status"
      ) {
        return { connected: false } as never;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await listInboxItems(
      [{ path: "/tmp/fork-a" }, { path: "/tmp/fork-b" }],
      { assignedToMe: false, state: "open", search: "" },
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      repo: "acme/web",
      projectPath: "/tmp/fork-a",
    });
    const listCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "git_github_work_items");
    expect(listCalls).toHaveLength(6);
    expect(
      listCalls.filter(
        ([, args]) =>
          String((args as Record<string, unknown>).repo).toLowerCase() ===
          "acme/web",
      ),
    ).toHaveLength(2);
  });

  it("reports an error when repository discovery fails", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "git_project_repositories") {
        return [String((args as { cwd: string }).cwd)] as never;
      }
      if (command === "git_github_repositories") {
        throw new Error("not a GitHub repository");
      }
      if (
        command === "linear_status" ||
        command === "jira_status" ||
        command === "gitlab_status" ||
        command === "azure_devops_status"
      ) {
        return { connected: false } as never;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(
      listInboxItems([{ path: "/tmp/local" }], {
        assignedToMe: false,
        state: "open",
        search: "",
      }),
    ).resolves.toEqual({
      items: [],
      errors: { github: "not a GitHub repository" },
    });
  });
});

describe("repository-qualified GitHub item operations", () => {
  it("passes the repository through and isolates same-number caches", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const input = args as Record<string, unknown>;
      if (command === "git_github_work_item_details") {
        return { body: String(input.repo), author: "octocat" } as never;
      }
      if (command === "git_github_work_item_thread") {
        return {
          comments: [],
          commits: [],
          truncated: false,
          reviewDecision: "",
          baseRefName: "main",
          headRefName: "feature",
        } as never;
      }
      if (command === "git_github_pr_diff") {
        return {
          additions: 1,
          deletions: 0,
          files: [],
          patch: "diff",
          truncated: false,
        } as never;
      }
      if (command === "git_github_work_item_comment") {
        return "https://github.com/acme/web/issues/10#issuecomment-1" as never;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await githubWorkItemDetails("/tmp/web", "maya/web", "issue", 10);
    await githubWorkItemDetails("/tmp/web", "acme/web", "issue", 10);
    expect(peekGithubWorkItemDetails("maya/web", "issue", 10)?.body).toBe(
      "maya/web",
    );
    expect(peekGithubWorkItemDetails("acme/web", "issue", 10)?.body).toBe(
      "acme/web",
    );

    await githubWorkItemThread("/tmp/web", "acme/web", "pr", 10);
    await githubPrDiff("/tmp/web", "acme/web", 10);
    await githubWorkItemComment(
      "/tmp/web",
      "acme/web",
      "issue",
      10,
      "Looks good",
    );

    expect(invoke).toHaveBeenCalledWith("git_github_work_item_thread", {
      cwd: "/tmp/web",
      repo: "acme/web",
      kind: "pr",
      number: 10,
    });
    expect(invoke).toHaveBeenCalledWith("git_github_pr_diff", {
      cwd: "/tmp/web",
      repo: "acme/web",
      number: 10,
      fullContext: false,
    });
    expect(invoke).toHaveBeenCalledWith("git_github_work_item_comment", {
      cwd: "/tmp/web",
      repo: "acme/web",
      kind: "issue",
      number: 10,
      body: "Looks good",
      inReplyTo: "",
    });
  });
});

describe("projects holding several repositories", () => {
  function mockProject(
    repositoriesByProject: Record<string, string[]>,
    slugsByRepo: Record<string, string[] | Error>,
  ) {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const input = args as Record<string, unknown>;
      if (command === "git_project_repositories") {
        return (repositoriesByProject[String(input.cwd)] ?? []) as never;
      }
      if (command === "git_github_repositories") {
        const slugs = slugsByRepo[String(input.cwd)];
        if (!slugs || slugs instanceof Error) {
          throw slugs ?? new Error("not a GitHub repository");
        }
        return slugs as never;
      }
      if (command === "git_github_work_items") {
        return (
          input.kind === "pr" ? [workItem(String(input.repo), "pr")] : []
        ) as never;
      }
      if (
        command === "linear_status" ||
        command === "jira_status" ||
        command === "gitlab_status" ||
        command === "azure_devops_status"
      ) {
        return { connected: false } as never;
      }
      throw new Error(`Unexpected command: ${command}`);
    });
  }

  const query = { assignedToMe: false, state: "open" as const, search: "" };

  it("tags items with the project and the checkout they came from", async () => {
    mockProject(
      { "/work/lr": ["/work/lr/api", "/work/lr/web"] },
      { "/work/lr/api": ["lr/api"], "/work/lr/web": ["lr/web"] },
    );

    const result = await listInboxItems([{ path: "/work/lr" }], query);

    expect(
      result.items
        .map(({ repo, projectPath, repoPath }) => ({ repo, projectPath, repoPath }))
        .sort((a, b) => a.repo.localeCompare(b.repo)),
    ).toEqual([
      { repo: "lr/api", projectPath: "/work/lr", repoPath: "/work/lr/api" },
      { repo: "lr/web", projectPath: "/work/lr", repoPath: "/work/lr/web" },
    ]);
    expect(invoke).toHaveBeenCalledWith(
      "git_github_work_items",
      expect.objectContaining({ cwd: "/work/lr/api", repo: "lr/api" }),
    );
    expect(result.errors).toEqual({});
  });

  it("keeps the other repositories when one has no GitHub remote", async () => {
    mockProject(
      { "/work/lr": ["/work/lr/api", "/work/lr/local-only"] },
      {
        "/work/lr/api": ["lr/api"],
        "/work/lr/local-only": new Error("no GitHub remote"),
      },
    );

    const result = await listInboxItems([{ path: "/work/lr" }], query);

    expect(result.items.map((item) => item.repo)).toEqual(["lr/api"]);
    expect(result.errors).toEqual({});
  });

  it("reports an error when a project has no GitHub repository", async () => {
    mockProject({ "/work/empty": [] }, {});

    await expect(
      listInboxItems([{ path: "/work/empty" }], query),
    ).resolves.toEqual({
      items: [],
      errors: { github: "No GitHub repository in this project" },
    });
  });

  it("fetches a repository shared by two projects once", async () => {
    mockProject(
      {
        "/work/lr": ["/work/lr/api", "/work/lr/web"],
        "/work/lr/api": ["/work/lr/api"],
      },
      { "/work/lr/api": ["lr/api"], "/work/lr/web": ["lr/web"] },
    );

    const result = await listInboxItems(
      [{ path: "/work/lr" }, { path: "/work/lr/api" }],
      query,
    );

    const apiCalls = vi
      .mocked(invoke)
      .mock.calls.filter(
        ([command, args]) =>
          command === "git_github_work_items" &&
          (args as Record<string, unknown>).repo === "lr/api",
      );
    expect(apiCalls).toHaveLength(2); // issue + pr, once
    expect(
      result.items.find((item) => item.repo === "lr/api")?.projectPath,
    ).toBe("/work/lr");
  });

  it("rediscovers repositories after the Inbox cache is cleared", async () => {
    mockProject({ "/work/lr": ["/work/lr/api"] }, { "/work/lr/api": ["lr/api"] });
    await projectRepositories("/work/lr");
    await projectRepositories("/work/lr/");
    clearInboxCache();
    await projectRepositories("/work/lr");

    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "git_project_repositories"),
    ).toHaveLength(2);
  });

  it("rediscovers repositories on a forced refresh and keeps the slug cache", async () => {
    const slugs = { "/work/lr/api": ["lr/api"], "/work/lr/web": ["lr/web"] };
    mockProject({ "/work/lr": ["/work/lr/api"] }, slugs);
    const first = await listInboxItems([{ path: "/work/lr" }], query);
    expect(first.items.map((item) => item.repo)).toEqual(["lr/api"]);

    mockProject({ "/work/lr": ["/work/lr/api", "/work/lr/web"] }, slugs);
    const refreshed = await listInboxItems([{ path: "/work/lr" }], query, {
      force: true,
    });

    expect(refreshed.items.map((item) => item.repo).sort()).toEqual([
      "lr/api",
      "lr/web",
    ]);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(
          ([command, args]) =>
            command === "git_github_repositories" &&
            (args as Record<string, unknown>).cwd === "/work/lr/api",
        ),
    ).toHaveLength(1);
  });
});

describe("inboxRepoPath", () => {
  it("falls back to the project for items without a checkout", () => {
    expect(inboxRepoPath({ projectPath: "/work/web" })).toBe("/work/web");
    expect(
      inboxRepoPath({ projectPath: "/work/lr", repoPath: "/work/lr/api" }),
    ).toBe("/work/lr/api");
  });
});
