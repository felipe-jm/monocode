import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import { sessionGitActivity } from "./sessionGitActivity";

let seq = 0;
function shell(command: string, detail = "", status = "completed"): Block {
  seq += 1;
  return {
    id: `tool-${seq}`,
    role: "tool",
    text: command,
    tool: { kind: "execute", title: command, status, detail },
  };
}

function branches(...blocks: Block[]): string[] {
  return sessionGitActivity(blocks).branches;
}

describe("sessionGitActivity branches", () => {
  it.each([
    ["git checkout master && git pull && git checkout -b chore/remove-x", "chore/remove-x"],
    ["git fetch -q upstream && git switch -c feat/auto upstream/main 2>&1 | tail -1", "feat/auto"],
    ["git switch --create=feat/eq", "feat/eq"],
    ["git -C backend fetch origin master && git -C backend worktree add ../.worktrees/be-t5171 -b fix/t5171-ncm origin/master", "fix/t5171-ncm"],
    ["cd ~/Developer/monocode && git worktree add -b feat/voice ../monocode-dictation origin/main 2>&1 | tail -1", "feat/voice"],
    ["git -C backend worktree add ../.worktrees/be-t5171 fix/t5171-ncm 2>&1 | tail -n 1", "fix/t5171-ncm"],
    ["git worktree add ../feature-x", "feature-x"],
    ["git branch feat/later origin/main", "feat/later"],
    ["gh pr create --base master --head chore/remove-x --title \"x\" --body \"$(cat <<'EOF'", "chore/remove-x"],
    ["gh pr create --head felipe:fix/fork", "fix/fork"],
    ["P=/repo; for p in \"agents main\"; do set -- $p; git -C $P/$1 worktree add -q -b chore/lean $P/$1-wt origin/$2; done", "chore/lean"],
  ])("reads the branch created by %s", (command, expected) => {
    expect(branches(shell(command))).toEqual([expected]);
  });

  it.each([
    "git worktree add --detach .claude/worktrees/review origin/main",
    "git worktree add ../review origin/main",
    "git worktree add ../review 1a2b3c4d",
    "git branch --show-current",
    "git branch -a | head -20",
    "git branch --no-merged main",
    "git checkout main",
    "git worktree list",
    "echo 'git checkout -b not-a-command'",
    "git checkout -b $BRANCH",
  ])("ignores %s", (command) => {
    expect(branches(shell(command))).toEqual([]);
  });

  it("counts only tool calls that completed", () => {
    expect(
      branches(
        shell("git checkout -b feat/failed", "", "failed"),
        shell("git checkout -b feat/running", "", "in_progress"),
        { id: "a", role: "assistant", text: "git checkout -b feat/prose" },
      ),
    ).toEqual([]);
  });

  it("drops deleted branches and moves re-created ones last", () => {
    expect(
      branches(
        shell("git checkout -b a"),
        shell("git checkout -b b"),
        shell("git checkout -b tmp"),
        shell("git branch -D tmp && git push"),
        shell("git switch -c a"),
      ),
    ).toEqual(["b", "a"]);
  });
});

describe("sessionGitActivity pull requests", () => {
  it("reads PR URLs printed by gh pr create, once per PR", () => {
    const create = shell(
      "gh pr create --base master --head chore/x --title \"x\"",
      "Warning: 1 uncommitted change\nhttps://github.com/lucrorural/frontend/pull/2285\n\n\nWall time: 3.23 seconds",
    );
    const again = shell(
      "git push -q && gh pr create --fill && gh pr view --json url",
      'https://github.com/Acme/App/pull/7\n{"url":"https://github.com/acme/app/pull/7"}',
    );
    expect(sessionGitActivity([create, again]).pullRequests).toEqual([
      {
        repo: "lucrorural/frontend",
        number: 2285,
        url: "https://github.com/lucrorural/frontend/pull/2285",
      },
      { repo: "Acme/App", number: 7, url: "https://github.com/Acme/App/pull/7" },
    ]);
  });

  it("ignores PR URLs outside a gh pr create call", () => {
    const blocks: Block[] = [
      shell("gh pr view 12 --json url", "https://github.com/acme/app/pull/12"),
      shell(
        "git push -u origin feat/x",
        "remote: Create a pull request for 'feat/x' on GitHub by visiting:\nremote:   https://github.com/acme/app/pull/new/feat/x",
      ),
      shell("gh pr create --fill", "https://github.com/acme/app/pull/13", "failed"),
      { id: "a", role: "assistant", text: "See https://github.com/acme/app/pull/14" },
    ];
    expect(sessionGitActivity(blocks).pullRequests).toEqual([]);
  });
});
