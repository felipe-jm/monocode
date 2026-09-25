# Multi-repo projects in the Inbox — design

Date: 2026-09-25
Status: approved design, pending spec review

## Goal

A MonoCode project folder may contain several git repositories as direct
children, each with its own worktrees. Example: `~/Developer/lucrorural/project`
holds 15 repositories (`backend`, `frontend`, `terminal`, …), all on
`github.com/lucrorural`, plus linked worktrees in sibling folders
(`backend-wt-*`) and hidden folders (`.worktrees/`).

Today such a project contributes nothing to the Inbox: `gh repo view` fails in
the non-repo root and the failure is swallowed when other projects succeed.

This delivery makes the Inbox list issues and PRs from every repository inside
a project, filterable per repository, with every follow-up action running in
the right checkout.

## Scope

In scope:

1. Repository discovery inside a project folder.
2. Inbox fetches, filters, and acts on items from every discovered repository.

Out of scope (a later delivery, "part 3"):

- Changes panel, branch indicator, and worktree controls per repository.
- Binding sessions to a specific repository or worktree.
- Auto-linking "PR #42" mentions for sessions whose cwd is a non-repo root
  (`resolveLinkedWorkItem` keeps using `githubRepo(cwd)`; full GitHub URLs
  still link).
- Creating a worktree from an Inbox PR.

Unchanged assumptions:

- The root folder remains one project on the rail.
- Sessions started from the Inbox run in the project root, so agents keep
  seeing root files such as `AGENTS.md`.
- The Inbox stays global across rail projects (no per-project Inbox view).

## 1. Repository discovery

### Rust: `git_project_repositories(root) -> Vec<String>`

New Tauri command in `src-tauri/src/fs.rs`, next to
`git_github_repositories_for`, registered in `lib.rs`.

1. If `root` is inside a git work tree (`git rev-parse --show-toplevel`
   succeeds), return `[toplevel]`. Single-repo projects keep today's behavior.
2. Otherwise, scan the **direct children** of `root` and include every child
   whose `.git` entry is a **directory**. Excluded:
   - children whose `.git` is a file (linked worktrees, e.g. `backend-wt-*`);
   - hidden children (name starts with `.`), e.g. `.worktrees`, `.venv`;
   - symlinks (not followed).
3. Return absolute paths sorted by folder name. A root with no repositories
   returns `[]`.

Discovery is filesystem-only after step 1; it spawns no git process per child.

A root `.git` that is not a valid repository (the GitKraken stub holding only
`gk/` and `info/`) fails step 1 and falls through to the scan, as intended.

### TypeScript: `projectRepositories(projectPath)`

In `src/features/inbox/model/githubTasks.ts`: wraps the command and caches
results per normalized project path for the app session, like
`repositoriesByPath`. `clearInboxCache` (Inbox refresh) also clears this cache,
so a newly cloned repository appears on the next refresh.

### GitHub slug resolution

Unchanged: `githubRepositories(repoPath)` (`gh repo view --json
nameWithOwner,parent`) runs per discovered repository, so fork parents and
`gh repo set-default` keep working. Calls run in parallel and are cached per
path until the app closes. A repository without a GitHub remote is skipped
without affecting the others.

## 2. Inbox

### Data model

`InboxItem` gains `repoPath: string`: the local checkout the item came from.

| Field | Role | Consumers |
|---|---|---|
| `projectPath` (existing) | project identity | logo, color, notifications, project filter, dedupe rank, cwd of sessions created from the item |
| `repoPath` (new) | checkout | cwd of every follow-up `gh` call: details, thread, comment, PR diff, PR actions, PR checks, check details |

For single-repo projects `repoPath === projectPath`. GitLab and Azure DevOps
items set `repoPath = projectPath` (empty when `projectPath` is empty); their
behavior is otherwise unchanged. Linear and Jira items set `repoPath = ""`.

Every call site that today passes `item.projectPath` as a `gh` cwd switches to
`item.repoPath` (InboxView detail, thread, comment, diff, PR action, checks,
check details, repair evidence). Session cwd call sites keep `projectPath`.

### Fetching

`fetchInboxItems` changes from "project → slugs" to
"project → repositories → slugs":

1. For each unique project, `projectRepositories(project.path)`.
2. For each repository path, `githubRepositories(repoPath)`.
3. Flatten to `{projectPath, repoPath, repo}`; `groupProjectsByRepo` still
   collapses duplicate slugs (first entry wins, preserving the current
   project-first order).
4. `gh {issue,pr} list --repo <slug>` per group and kind, tagging each item with
   `projectPath` and `repoPath`.

Failure handling is unchanged: discovery or slug failures are collected and
surface as `errors.github` only when no batch succeeds.

### Filter

`InboxFilters` gains `hiddenRepos: string[]` (lowercased `owner/name`
slugs), persisted with the other filters.

- In `InboxFiltersMenu`, a project with more than one repository lists its
  repositories as nested checkboxes under the project checkbox, labelled by
  slug.
- Hiding the project hides all its repositories (existing behavior); a
  repository checkbox hides only items whose `repo` matches.
- `pruneInboxFilters` does not prune `hiddenRepos`: slugs are stable and a
  hidden slug that no longer appears has no effect.
- Default: empty, so every repository is visible.

### Cards and detail

No change. Cards and the detail header already show `item.repo`; text search
already matches it.

### Actions

- **Send to agent** (issues only) and **Fix CI** create or reuse sessions in
  `projectPath`. The Fix CI "chat from this project" check keeps comparing
  against `projectPath`.
- When `repoPath !== projectPath`, the Fix CI prompt adds:
  `The repository checkout for this PR is at <repoPath>.`
  The existing instruction to verify the local checkout stays.

## Error handling

- Discovery command errors (unreadable root) reject for that project only.
- A child repository whose `gh repo view` fails is skipped; others still load.
- Item actions whose `repoPath` no longer exists surface `gh`'s error in the
  detail view, as they do today for a moved project.

## Testing

- Rust unit tests for discovery, using temporary directories: root that is a
  repo, root with child repos, child with `.git` file (worktree) excluded,
  hidden child excluded, symlinked child excluded, invalid root `.git` stub
  falls through to the scan, empty root returns `[]`.
- `githubTasks.repositories.test.ts`: a multi-repo project yields items tagged
  with the right `repoPath` and `projectPath`; a failing child repository does
  not drop the others; duplicate slugs across projects collapse.
- `inboxFilters` tests: `hiddenRepos` hides only matching items and survives
  pruning.
- `ciRepair` test: the prompt includes the checkout line only when
  `repoPath !== projectPath`.
- Manual check: open the Inbox with `~/Developer/lucrorural/project` on the
  rail and confirm PRs from its repositories appear, the repository filter
  works, and PR diff and checks load.

## Changelog

Add an "Added" entry under Unreleased describing multi-repo projects in the
Inbox and the per-repository filter.
