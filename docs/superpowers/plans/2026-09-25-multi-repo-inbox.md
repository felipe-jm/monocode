# Multi-repo projects in the Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** List GitHub issues and PRs from every repository inside a project folder in the Inbox, with a per-repository filter and follow-up actions running in the right checkout.

**Architecture:** A new Rust command finds the repositories in a project folder (the repository containing it, or else every direct child with its own `.git` directory). The Inbox resolves GitHub slugs per repository instead of per project, tags each item with the checkout it came from (`repoPath`), and routes `gh` calls through it. A client-side filter hides items by repository slug.

**Tech Stack:** Rust (Tauri 2 commands, `std::fs`), TypeScript + React, Vitest, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-09-25-multi-repo-inbox-design.md`

## Global Constraints

- Single-repo projects behave exactly as today: discovery returns `[projectPath]`, so `repoPath === projectPath`.
- Discovery scans **direct children only**; excludes children whose `.git` is a file, hidden children (name starts with `.`), and symlinks.
- GitHub slugs still come from `gh repo view --json nameWithOwner,parent` (`githubRepositories`), per repository.
- Sessions created from the Inbox keep `cwd = projectPath`.
- `hiddenRepos` holds lowercased `owner/name` slugs and is never pruned.
- Vitest must run with `--maxWorkers=2` (local safety hook). Global `tsc` is blocked locally; rely on Vitest and CI for types.
- Repository language for code, comments, tests, commits, and changelog: English.

## Design deviations from the spec (recorded in Task 5)

1. `InboxItem.repoPath` is **optional**; `inboxRepoPath(item)` returns `item.repoPath || item.projectPath`. Linear, Jira, GitLab, Azure DevOps, and cached items need no change.
2. `InboxPrChecks` keeps `cwd = projectPath` because it is also the CI-repair tracking key (`useCheckRepairs` matches `trackCiRepair(cwd)` from `App.tsx:9333`). Check details use `gh api --hostname github.com`, which does not depend on cwd. `useGithubPrChecks` switches to `repoPath`.

## Review Focus

1. A project with repositories where **none** has a GitHub remote: the Inbox should show a GitHub error only if no other project succeeds, not crash or hang. (Task 2, test "reports an error when a project has no GitHub repository".)
2. The **same repository reachable from two rail projects** (e.g. `~/Developer/lucrorural/project` and `~/Developer/lucrorural/project/backend` both on the rail): one fetch, item attributed to the first-ranked project. (Task 2, test "fetches a repository shared by two projects once".)
3. **Root folder with a broken `.git` stub** (GitKraken `gk/` + `info/`): treated as a non-repo and scanned. (Task 1, test `project_repositories_scan_children_under_a_stub_git_dir`.)
4. **Hiding a project hides its repositories**, and un-hiding it restores them without leftover repo filters surprising the user. (Task 4, test "hides a project's repositories with the project".)
5. **PR action refresh keeps the checkout**: after merge/close in the detail view, follow-up calls still use `repoPath`. (Task 3, Step 3 `setItem` keeps `repoPath`; covered manually in Task 5.)

---

### Task 1: Rust repository discovery command

**Files:**
- Modify: `src-tauri/src/fs.rs` (add command next to `git_github_repositories`, ~L1175-1181; add helper next to `git_github_repositories_for`, ~L2487; tests in `mod tests`, after `init_git` ~L5989)
- Modify: `src-tauri/src/lib.rs:320` (register command)

**Interfaces:**
- Produces: Tauri command `git_project_repositories(cwd: String) -> Result<Vec<String>, String>`; absolute paths, sorted by folder name.

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `src-tauri/src/fs.rs`, after `fn init_git`:

```rust
    fn canonical(paths: Vec<String>) -> Vec<PathBuf> {
        paths
            .into_iter()
            .map(|path| PathBuf::from(path).canonicalize().unwrap())
            .collect()
    }

    #[test]
    fn project_repositories_return_the_repository_containing_the_root() {
        let dir = tmp("project-repos-single");
        if !init_git(&dir.0, "main", None) {
            return;
        }
        std::fs::create_dir_all(dir.0.join("src")).unwrap();
        assert_eq!(
            canonical(git_project_repositories_for(&dir.0.join("src")).unwrap()),
            [dir.0.canonicalize().unwrap()]
        );
    }

    #[test]
    fn project_repositories_list_child_repositories_only() {
        let dir = tmp("project-repos-children");
        for name in ["web", "api"] {
            let child = dir.0.join(name);
            std::fs::create_dir_all(&child).unwrap();
            if !init_git(&child, "main", None) {
                return;
            }
        }
        // Linked worktree: `.git` is a file.
        let worktree = dir.0.join("api-wt-feature");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(worktree.join(".git"), "gitdir: /elsewhere\n").unwrap();
        // Hidden folder holding a repository.
        let hidden = dir.0.join(".worktrees");
        std::fs::create_dir_all(hidden.join(".git")).unwrap();
        // Plain folder and plain file.
        std::fs::create_dir_all(dir.0.join("docs")).unwrap();
        std::fs::write(dir.0.join("notes.md"), "x\n").unwrap();
        // Symlink to a repository is not followed.
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.0.join("web"), dir.0.join("web-link")).unwrap();

        assert_eq!(
            canonical(git_project_repositories_for(&dir.0).unwrap()),
            [
                dir.0.join("api").canonicalize().unwrap(),
                dir.0.join("web").canonicalize().unwrap(),
            ]
        );
    }

    #[test]
    fn project_repositories_scan_children_under_a_stub_git_dir() {
        let dir = tmp("project-repos-stub");
        std::fs::create_dir_all(dir.0.join(".git").join("gk")).unwrap();
        std::fs::create_dir_all(dir.0.join(".git").join("info")).unwrap();
        let child = dir.0.join("backend");
        std::fs::create_dir_all(&child).unwrap();
        if !init_git(&child, "main", None) {
            return;
        }
        assert_eq!(
            canonical(git_project_repositories_for(&dir.0).unwrap()),
            [child.canonicalize().unwrap()]
        );
    }

    #[test]
    fn project_repositories_are_empty_without_repositories() {
        let dir = tmp("project-repos-empty");
        std::fs::create_dir_all(dir.0.join("docs")).unwrap();
        assert!(git_project_repositories_for(&dir.0).unwrap().is_empty());
    }
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cargo test --lib project_repositories` (cwd `src-tauri`)
Expected: compile error `cannot find function git_project_repositories_for`.

- [ ] **Step 3: Implement the helper and the command**

In `src-tauri/src/fs.rs`, after `git_github_repositories` (~L1181):

```rust
/// The repositories a project folder holds: the one containing it, or else
/// every direct child with its own `.git` directory.
#[tauri::command]
pub async fn git_project_repositories(cwd: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || git_project_repositories_for(&expand_home(&cwd)))
        .await
        .map_err(|e| e.to_string())?
}
```

After `git_github_repositories_for` (~L2490):

```rust
/// Linked worktrees (a `.git` file), hidden folders and symlinks are skipped:
/// worktrees belong to their main checkout, and the rest are tool state.
fn git_project_repositories_for(root: &Path) -> Result<Vec<String>, String> {
    if let Some(top) = git_stdout(root, &["rev-parse", "--show-toplevel"])
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
    {
        return Ok(vec![top.to_string_lossy().into_owned()]);
    }
    let mut repositories: Vec<PathBuf> = std::fs::read_dir(root)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        // `DirEntry::file_type` does not follow symlinks.
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .map(|entry| entry.path())
        .filter(|path| {
            std::fs::symlink_metadata(path.join(".git")).is_ok_and(|meta| meta.is_dir())
        })
        .collect();
    repositories.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    Ok(repositories
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}
```

In `src-tauri/src/lib.rs`, after `fs::git_github_repositories,` (L320):

```rust
            fs::git_project_repositories,
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cargo test --lib project_repositories` (cwd `src-tauri`)
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/fs.rs src-tauri/src/lib.rs
git commit -m "Discover the git repositories inside a project folder"
```

---

### Task 2: Fetch Inbox items across a project's repositories

**Files:**
- Modify: `src/features/inbox/model/githubTasks.ts` (`InboxItem` L76-90; caches L188-215; new `projectRepositories` + `inboxRepoPath` after `githubRepositories` L283-296; `fetchInboxItems` L680-715; `groupProjectsByRepo` L984-1000)
- Test: `src/features/inbox/model/githubTasks.repositories.test.ts`
- Modify (mocks only): `src/features/inbox/model/githubTasks.providers.test.ts:52`, `src/features/inbox/model/jira.test.ts:118`

**Interfaces:**
- Consumes: Tauri command `git_project_repositories({ cwd }) -> string[]` (Task 1).
- Produces:
  - `InboxItem.repoPath?: string` — local checkout the item came from.
  - `export function inboxRepoPath(item: Pick<InboxItem, "repoPath" | "projectPath">): string` — `item.repoPath || item.projectPath`.
  - `export async function projectRepositories(projectPath: string): Promise<string[]>`.
  - `groupProjectsByRepo<T extends { path: string; repo: string }>(resolved: readonly T[]): T[]`.

- [ ] **Step 1: Add the discovery mock to existing tests**

These tests mock `invoke` strictly and would throw `Unexpected command: git_project_repositories`. A single-repo project resolves to itself:

`githubTasks.repositories.test.ts`, inside both `mockImplementation` blocks of the `"GitHub fork repositories"` describe (tests at L56 and L109), as the first line of the callback (change the L110 callback signature to `async (command, args)`):

```ts
      if (command === "git_project_repositories") {
        return [String((args as { cwd: string }).cwd)] as never;
      }
```

`githubTasks.providers.test.ts`, before L52:

```ts
      if (command === "git_project_repositories") return [String((args as { cwd: string }).cwd)];
```

`jira.test.ts`, before L118:

```ts
      if (command === "git_project_repositories") return [String((args as { cwd: string }).cwd)];
```

- [ ] **Step 2: Write the failing tests**

Append to `githubTasks.repositories.test.ts`:

```ts
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
});

describe("inboxRepoPath", () => {
  it("falls back to the project for items without a checkout", () => {
    expect(inboxRepoPath({ projectPath: "/work/web" })).toBe("/work/web");
    expect(
      inboxRepoPath({ projectPath: "/work/lr", repoPath: "/work/lr/api" }),
    ).toBe("/work/lr/api");
  });
});
```

Add `inboxRepoPath` and `projectRepositories` to the import list at the top of the file.

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run src/features/inbox/model/githubTasks.repositories.test.ts --maxWorkers=2`
Expected: FAIL — `inboxRepoPath` / `projectRepositories` are not exported.

- [ ] **Step 4: Implement**

`InboxItem` (L76-90), after `projectPath: string;`:

```ts
  /** Local checkout the item came from; the project itself when absent. */
  repoPath?: string;
```

Caches, after `repositoriesByPath` (L189):

```ts
const repositoriesByProject = new Map<string, string[]>();
```

In `clearInboxCache`, after `repositoriesByPath.clear();`:

```ts
  repositoriesByProject.clear();
```

After `githubRepositories` (L296):

```ts
/** Checkout the item's `gh` calls run in. */
export function inboxRepoPath(
  item: Pick<InboxItem, "repoPath" | "projectPath">,
): string {
  return item.repoPath || item.projectPath;
}

/** Git repositories a project folder holds; the folder's own repo when it is one. */
export async function projectRepositories(
  projectPath: string,
): Promise<string[]> {
  const key = normalizeProjectPath(projectPath);
  const cached = repositoriesByProject.get(key);
  if (cached) return cached;
  const repositories = await invoke<string[]>("git_project_repositories", {
    cwd: projectPath,
  });
  repositoriesByProject.set(key, repositories);
  return repositories;
}

async function projectGithubRepositories(
  projectPath: string,
): Promise<{ path: string; repoPath: string; repo: string }[]> {
  const repoPaths = await projectRepositories(projectPath);
  const settled = await Promise.allSettled(
    repoPaths.map((repoPath) => githubRepositories(repoPath)),
  );
  const found = settled.flatMap((result, index) =>
    result.status === "fulfilled"
      ? result.value.map((repo) => ({
          path: projectPath,
          repoPath: repoPaths[index]!,
          repo,
        }))
      : [],
  );
  if (found.length > 0) return found;
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  throw failure?.reason ?? new Error("No GitHub repository in this project");
}
```

`fetchInboxItems` (replace L686-708):

```ts
  const discovery = await Promise.allSettled(
    unique.map((project) => projectGithubRepositories(project.path)),
  );
  const resolved = discovery.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  const grouped = groupProjectsByRepo(resolved);
  const githubJobs = grouped.flatMap((project) =>
    (["issue", "pr"] as const).map(async (kind) => {
      const items = await listGithubWorkItems(project.repoPath, project.repo, {
        ...query,
        kind,
      });
      return items.map((item) => ({
        ...item,
        projectPath: project.path,
        repoPath: project.repoPath,
        provider: "github" as const,
        repo: item.repo || project.repo,
      }));
    }),
  );
```

`groupProjectsByRepo` (replace L984-1000):

```ts
export function groupProjectsByRepo<T extends { path: string; repo: string }>(
  resolved: readonly T[],
): T[] {
  const seen = new Set<string>();
  const grouped: T[] = [];
  for (const project of resolved) {
    const repo = project.repo.trim().toLowerCase();
    const key = repo || `path:${normalizeProjectPath(project.path)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    grouped.push({ ...project, repo: project.repo.trim() });
  }
  return grouped;
}
```

- [ ] **Step 5: Run the inbox model tests and confirm they pass**

Run: `npx vitest run src/features/inbox/model --maxWorkers=2`
Expected: all pass, including the existing fork and error tests.

- [ ] **Step 6: Commit**

```bash
git add src/features/inbox/model/githubTasks.ts src/features/inbox/model/githubTasks.repositories.test.ts src/features/inbox/model/githubTasks.providers.test.ts src/features/inbox/model/jira.test.ts
git commit -m "Fetch Inbox items from every repository inside a project"
```

---

### Task 3: Run Inbox actions in the item's checkout and name it for CI repair

**Files:**
- Modify: `src/features/inbox/ui/InboxView.tsx` (L1703, L1717-1719, L2104, L2164, L2193, L2344, L2371, L2400, L2426, L2497, L2508, L2891, L2902-2920)
- Modify: `src/features/inbox/model/ciRepair.ts:43-101`
- Modify: `src/features/inbox/ui/CheckRepairForm.tsx:24-31, 132-137`
- Test: `src/features/inbox/model/ciRepair.test.ts`

**Interfaces:**
- Consumes: `inboxRepoPath(item)` (Task 2).
- Produces:
  - `buildCiRepairRequest({ repo, number, headOid, evidence, checkout? })` — `checkout?: string` adds one prompt line.
  - `CheckRepair.checkout?: string`.

- [ ] **Step 1: Write the failing test**

Append to `src/features/inbox/model/ciRepair.test.ts`:

```ts
it("names the checkout when the PR's repository sits inside the project", () => {
  const evidence = [
    { name: "test", workflow: "CI", url: "https://github.com/acme/web/actions/runs/1/job/2", state: "FAILURE" },
  ] as Parameters<typeof buildCiRepairRequest>[0]["evidence"];

  const nested = buildCiRepairRequest({
    repo: "acme/web",
    number: 42,
    headOid: "abc123",
    evidence,
    checkout: "/work/lr/web",
  });
  const plain = buildCiRepairRequest({
    repo: "acme/web",
    number: 42,
    headOid: "abc123",
    evidence,
  });

  expect(nested.prompt).toContain(
    "The repository checkout for this PR is at /work/lr/web.",
  );
  expect(plain.prompt).not.toContain("repository checkout for this PR");
});
```

If `GithubPrCheck` requires more fields than the literal above, copy the evidence literal from the first test in the same file instead of the cast.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/features/inbox/model/ciRepair.test.ts --maxWorkers=2`
Expected: FAIL — prompt lacks the checkout line.

- [ ] **Step 3: Implement**

`ciRepair.ts` `buildCiRepairRequest` params (L43-53):

```ts
export function buildCiRepairRequest({
  repo,
  number,
  headOid,
  evidence,
  checkout,
}: {
  repo: string;
  number: number;
  headOid: string;
  evidence: CiRepairEvidence[];
  /** Repository checkout inside a multi-repo project; omitted when it is the project. */
  checkout?: string;
}): CiRepairRequest {
```

In `prefix` (L93-101), after the `Checked commit` line:

```ts
    ...(checkout
      ? [`The repository checkout for this PR is at ${checkout}.`]
      : []),
```

`CheckRepairForm.tsx` `CheckRepair` type (L24-31), add:

```ts
  /** Repository checkout inside a multi-repo project. */
  checkout?: string;
```

and in the call (L132-137) add `checkout: repair.checkout,`.

`InboxView.tsx`:
- Import `inboxRepoPath` from `../model/githubTasks`.
- Replace `item.projectPath` with `inboxRepoPath(item)` as the **first argument** of: `githubPrAction` (L1703), `githubWorkItemDetails` (L2164), `githubWorkItemThread` (L2344, L2508), `githubPrDiff` (L2400), `githubWorkItemComment` (L2497); in `useGithubPrChecks({ cwd: ... })` (L2104) use `cwd: inboxRepoPath(item) || cwd`.
- In the matching `useEffect`/`useCallback` dependency arrays (L2193, L2371, L2426) add `item.repoPath` next to `item.projectPath`.
- `InboxPrDiff` key (L2891): `` key={`${inboxRepoPath(item)}:${item.number}:${revision}:${diffMode}`} ``.
- PR action refresh (L1717-1719) keeps the checkout:

```ts
        ...next,
        projectPath: item.projectPath,
        repoPath: item.repoPath,
        provider: "github",
```

- `InboxPrChecks` (L2902) keeps `cwd={item.projectPath || cwd}`; add above it:

```tsx
                // The project, not the checkout: CI repairs are tracked by the
                // session's project (App.onRepairChecks → trackCiRepair).
```

- In the `repair` object (L2908-2919), add:

```ts
                        checkout: sameProjectPath(inboxRepoPath(item), item.projectPath)
                          ? undefined
                          : inboxRepoPath(item),
```

- [ ] **Step 4: Run the Inbox tests and confirm they pass**

Run: `npx vitest run src/features/inbox --maxWorkers=2`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/features/inbox/ui/InboxView.tsx src/features/inbox/model/ciRepair.ts src/features/inbox/model/ciRepair.test.ts src/features/inbox/ui/CheckRepairForm.tsx
git commit -m "Run Inbox actions in the item's checkout"
```

---

### Task 4: Per-repository Inbox filter

**Files:**
- Modify: `src/features/inbox/model/inboxFilters.ts` (`InboxFilters` L20-28, defaults L48-55, `loadInboxFilters` L180-212, `hasActiveInboxFilters` L236-261, new `filterInboxByRepo` + `inboxRepoOptions` after `filterInboxByProject` L283, `applyInboxFilters` L369-400)
- Modify: `src/features/inbox/ui/InboxFiltersMenu.tsx` (Props L26-43, toggles ~L106-111, Projects section L264-290, `FilterItem` L327-354)
- Modify: `src/features/inbox/ui/InboxView.tsx` (~L463 options memo; `InboxFiltersMenu` props ~L1092-1095)
- Test: `src/features/inbox/model/inboxFilters.test.ts`

**Interfaces:**
- Consumes: `InboxItem.repoPath` (Task 2).
- Produces:
  - `InboxFilters.hiddenRepos: string[]` (lowercased slugs).
  - `export function filterInboxByRepo(items: readonly InboxItem[], hiddenRepos: Iterable<string>): InboxItem[]`.
  - `export function inboxRepoOptions(items: readonly InboxItem[]): Map<string, string[]>` — normalized project path → slugs (display case, sorted), only for GitHub items whose checkout differs from the project.
  - `InboxFiltersMenu` prop `reposByProject: ReadonlyMap<string, readonly string[]>`.

- [ ] **Step 1: Write the failing tests**

Append to `src/features/inbox/model/inboxFilters.test.ts` (add `filterInboxByRepo`, `inboxRepoOptions`, `loadInboxFilters`, `pruneInboxFilters`, and `type InboxItem` to the imports if missing; reuse the file's existing item factory if it has one, otherwise use this one):

```ts
describe("repository filter", () => {
  function repoItem(
    repo: string,
    number: number,
    projectPath = "/work/lr",
    repoPath = `/work/lr/${repo.split("/")[1]}`,
  ): InboxItem {
    return {
      provider: "github",
      kind: "pr",
      number,
      title: `${repo} #${number}`,
      url: `https://github.com/${repo}/pull/${number}`,
      state: "open",
      updatedAt: "2026-09-25T10:00:00Z",
      labels: [],
      assignees: [],
      draft: false,
      repo,
      projectPath,
      repoPath,
    };
  }

  const rows = [
    repoItem("lr/api", 1),
    repoItem("LR/Web", 2),
    repoItem("acme/site", 3, "/work/site", "/work/site"),
  ];

  it("hides only items from hidden repositories, ignoring case", () => {
    expect(filterInboxByRepo(rows, ["lr/web"]).map((row) => row.number)).toEqual(
      [1, 3],
    );
  });

  it("hides a project's repositories with the project", () => {
    expect(
      applyInboxFilters(
        rows,
        { ...DEFAULT_INBOX_FILTERS, hiddenProjects: ["/work/lr"], hiddenRepos: [] },
        "",
      ).map((row) => row.number),
    ).toEqual([3]);
  });

  it("applies the repository filter on the GitHub tab", () => {
    expect(
      applyInboxFilters(
        rows,
        { ...DEFAULT_INBOX_FILTERS, hiddenRepos: ["lr/api"] },
        "",
        Date.now(),
        "github",
      ).map((row) => row.number),
    ).toEqual([2, 3]);
    expect(
      hasActiveInboxFilters(
        { ...DEFAULT_INBOX_FILTERS, hiddenRepos: ["lr/api"] },
        "github",
      ),
    ).toBe(true);
  });

  it("offers repositories only for projects holding several", () => {
    expect([...inboxRepoOptions(rows)]).toEqual([
      ["/work/lr", ["lr/api", "LR/Web"]],
    ]);
  });

  it("keeps hidden repositories when pruning projects", () => {
    const filters = {
      ...DEFAULT_INBOX_FILTERS,
      hiddenProjects: ["/gone"],
      hiddenRepos: ["lr/api"],
    };
    expect(pruneInboxFilters(filters, ["/work/lr"]).hiddenRepos).toEqual([
      "lr/api",
    ]);
  });

  it("loads saved repositories lowercased and drops invalid entries", () => {
    localStorage.setItem(
      "monocode.inboxFilters",
      JSON.stringify({ hiddenRepos: ["LR/Api", "", 7] }),
    );
    expect(loadInboxFilters().hiddenRepos).toEqual(["lr/api"]);
    localStorage.removeItem("monocode.inboxFilters");
  });
});
```

If `inboxFilters.test.ts` runs without a DOM `localStorage`, add `// @vitest-environment jsdom` only if other tests in `src/features/inbox/model` use it; otherwise drop the last test and cover loading manually in Task 5.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/features/inbox/model/inboxFilters.test.ts --maxWorkers=2`
Expected: FAIL — `filterInboxByRepo` is not exported.

- [ ] **Step 3: Implement the model**

`inboxFilters.ts`:

Import `sameProjectPath` next to `normalizeProjectPath` (L8).

`InboxFilters` (L20-28), after `hiddenProjects`:

```ts
  /** Lowercased GitHub `owner/name` slugs to hide. */
  hiddenRepos: string[];
```

`DEFAULT_INBOX_FILTERS` (L48-55), after `hiddenProjects: [],`:

```ts
  hiddenRepos: [],
```

`loadInboxFilters` (after the `hiddenProjects` entry, L192):

```ts
      hiddenRepos: Array.isArray(parsed.hiddenRepos)
        ? parsed.hiddenRepos
            .filter(
              (repo): repo is string =>
                typeof repo === "string" && repo.length > 0,
            )
            .map((repo) => repo.toLowerCase())
        : [],
```

`hasActiveInboxFilters` (L250-259), add a clause:

```ts
    ((source === undefined || source === "github") &&
      filters.hiddenRepos.length > 0) ||
```

After `filterInboxByProject` (L283):

```ts
export function filterInboxByRepo(
  items: readonly InboxItem[],
  hiddenRepos: Iterable<string>,
): InboxItem[] {
  const hidden = new Set([...hiddenRepos].map((repo) => repo.toLowerCase()));
  if (hidden.size === 0) return [...items];
  return items.filter(
    (item) => item.provider !== "github" || !hidden.has(item.repo.toLowerCase()),
  );
}

/**
 * Repositories to list under each project that holds several, derived from
 * the fetched items. A single-repo project gets no entry.
 */
export function inboxRepoOptions(
  items: readonly InboxItem[],
): Map<string, string[]> {
  const byProject = new Map<string, Map<string, string>>();
  for (const item of items) {
    if (item.provider !== "github" || !item.projectPath || !item.repoPath) continue;
    if (sameProjectPath(item.repoPath, item.projectPath)) continue;
    const project = normalizeProjectPath(item.projectPath);
    const repos = byProject.get(project) ?? new Map<string, string>();
    const key = item.repo.toLowerCase();
    if (!repos.has(key)) repos.set(key, item.repo);
    byProject.set(project, repos);
  }
  return new Map(
    [...byProject].map(([project, repos]) => [
      project,
      [...repos.values()].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" }),
      ),
    ]),
  );
}
```

`applyInboxFilters` (L383-399): wrap the project filter:

```ts
          filterInboxByLinearProject(
            filterInboxByRepo(
              filterInboxByProject(scoped, hiddenProjects),
              isTrackerSource(source) ? [] : filters.hiddenRepos,
            ),
            filters.hiddenLinearProjects,
          ),
```

- [ ] **Step 4: Run the model tests and confirm they pass**

Run: `npx vitest run src/features/inbox/model/inboxFilters.test.ts --maxWorkers=2`
Expected: all pass.

- [ ] **Step 5: Implement the menu and wiring**

`InboxFiltersMenu.tsx`:

Import `normalizeProjectPath` from `../../projects/model/recents`.

Props (L26-43), after `projects`:

```ts
  /** Repositories under each multi-repo project, keyed by normalized project path. */
  reposByProject: ReadonlyMap<string, readonly string[]>;
```

Destructure `reposByProject`. After `toggleProject` (L111):

```ts
  const hiddenRepos = new Set(filters.hiddenRepos);
  const toggleRepo = (repo: string) => {
    const key = repo.toLowerCase();
    const next = new Set(hiddenRepos);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange({ ...filters, hiddenRepos: [...next] });
  };
```

Projects section (replace the `projects.map` body, L272-288):

```tsx
          {projects.map((project) => {
            const hidden = hiddenProjects.has(project.path);
            const repos =
              source === "github" && !hidden
                ? (reposByProject.get(normalizeProjectPath(project.path)) ?? [])
                : [];
            return (
              <Fragment key={project.path}>
                <FilterItem
                  label={project.name}
                  checked={!hidden}
                  icon={
                    project.logoPath ? (
                      <ProjectLogoIcon
                        path={project.logoPath}
                        className="size-3.5 shrink-0 rounded-sm"
                        imageClassName="size-3.5"
                      />
                    ) : undefined
                  }
                  onClick={() => toggleProject(project.path)}
                />
                {repos.map((repo) => (
                  <FilterItem
                    key={repo}
                    label={repo}
                    inset
                    checked={!hiddenRepos.has(repo.toLowerCase())}
                    onClick={() => toggleRepo(repo)}
                  />
                ))}
              </Fragment>
            );
          })}
```

Import `Fragment` from `react` (merge with the existing `ReactNode` import).

`FilterItem` (L327-354): add `inset?: boolean` to props and destructuring, and change the class:

```tsx
      className={`flex h-7 w-full items-center gap-2 rounded-lg ${inset ? "pl-7 pr-2" : "px-2"} text-left text-[13px] leading-none text-content hover:bg-content/5`}
```

`InboxView.tsx`:
- Import `inboxRepoOptions` from `../model/inboxFilters`.
- After `linearProjects` (L463):

```ts
  const repoOptions = useMemo(() => inboxRepoOptions(items), [items]);
```

- In `<InboxFiltersMenu` (L1092-1095), after `projects={projectOptions}`:

```tsx
      reposByProject={repoOptions}
```

- [ ] **Step 6: Run the Inbox tests and confirm they pass**

Run: `npx vitest run src/features/inbox --maxWorkers=2`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/features/inbox/model/inboxFilters.ts src/features/inbox/model/inboxFilters.test.ts src/features/inbox/ui/InboxFiltersMenu.tsx src/features/inbox/ui/InboxView.tsx
git commit -m "Filter the Inbox by repository inside multi-repo projects"
```

---

### Task 5: Changelog, spec deviations, and manual verification

**Files:**
- Modify: `CHANGELOG.md` (Unreleased)
- Modify: `docs/superpowers/specs/2026-09-25-multi-repo-inbox-design.md` ("Data model" section)

- [ ] **Step 1: Changelog**

Under `## [Unreleased]` add (create `### Added` if absent):

```markdown
- The Inbox lists issues and pull requests from every git repository inside a project folder, not only from a folder that is itself a repository. Linked worktrees and hidden folders are skipped. In the filter menu, a project holding several repositories lists them so each can be hidden. PR details, diffs, checks, and actions run in the repository's own checkout, and Fix CI tells the agent where that checkout is.
```

- [ ] **Step 2: Record the deviations in the spec**

In the spec's "Data model" section, replace the sentence starting "`InboxItem` gains `repoPath: string`" with:

```markdown
`InboxItem` gains an optional `repoPath`: the local checkout the item came
from. `inboxRepoPath(item)` returns `repoPath || projectPath`, so Linear,
Jira, GitLab, Azure DevOps, and cached items need no change.
```

Replace the paragraph "Every call site that today passes `item.projectPath` as a `gh` cwd…" with:

```markdown
Every call site that passes `item.projectPath` as a `gh` cwd switches to
`inboxRepoPath(item)` (details, thread, comment, diff, PR action, PR checks
list). `InboxPrChecks` keeps `projectPath` as its `cwd` because it also keys
CI-repair tracking (`trackCiRepair`); its check-details calls go through
`gh api` and do not depend on cwd. Session cwd call sites keep `projectPath`.
```

- [ ] **Step 3: Run the affected suites**

Run: `npx vitest run src/features/inbox src/features/sessions/model/ciRepairContext.test.ts --maxWorkers=2`
Expected: all pass.

Run: `cargo test --lib project_repositories` (cwd `src-tauri`)
Expected: 4 passed.

- [ ] **Step 4: Manual verification in the app**

Run the app (`npm run tauri dev`), with `~/Developer/lucrorural/project` on the rail:

1. Open the Inbox → GitHub tab. PRs from `lucrorural/backend`, `lucrorural/frontend`, `lucrorural/terminal`, … appear; each card shows its slug.
2. Open the filter menu. Under the Lucro Rural project, repositories are listed (only those with items). Uncheck `lucrorural/pagina-estrategia-2026`; its items disappear; the filter dot shows active. Reload the app; the choice persists.
3. Uncheck the Lucro Rural project; all its repositories' items disappear and its repository rows are no longer listed. Re-check it.
4. Open a `lucrorural/backend` PR: the Discussion, Code (diff), and Checks tabs load. Run a PR action that is safe to repeat (e.g. mark as draft, then ready) and confirm the detail still loads afterwards.
5. On a PR with a failed check, open Fix CI and start a repair in a new chat. The chat opens in the Lucro Rural project root, and the first message's prompt contains `The repository checkout for this PR is at …/project/backend.`
6. A single-repo project on the rail (e.g. `~/Developer/monocode`) still lists its items and shows no repository rows in the filter.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md docs/superpowers/specs/2026-09-25-multi-repo-inbox-design.md
git commit -m "Document multi-repo projects in the Inbox"
```
