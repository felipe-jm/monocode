import type { Block } from "./session";
import { toolCallState } from "./transcriptActivity";

/** A pull request whose URL `gh pr create` printed during the session. */
export type SessionPullRequest = {
  repo: string;
  number: number;
  url: string;
};

/** Branches and pull requests the agent created in this session, oldest first. */
export type SessionGitActivity = {
  branches: string[];
  pullRequests: SessionPullRequest[];
};

type BlockGitFacts = {
  created: string[];
  deleted: string[];
  pullRequests: SessionPullRequest[];
};

const NO_FACTS: BlockGitFacts = { created: [], deleted: [], pullRequests: [] };

/** Blocks are replaced, never mutated, so a finished block is parsed once. */
const factsCache = new WeakMap<Block, BlockGitFacts>();

const PR_URL_RE =
  /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\b/gi;

/** Split a shell command into simple commands; quotes and escapes are honoured loosely. */
function commandSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  const endWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && index + 1 < command.length) {
        index += 1;
        word += command[index];
      } else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      index += 1;
      // A backslash-newline continues the command on the next line.
      if (command[index] !== "\n") {
        word += command[index];
        started = true;
      }
      continue;
    }
    if (/[\r\n;&|()]/.test(char)) {
      endSegment();
      continue;
    }
    if (/\s/.test(char)) {
      endWord();
      continue;
    }
    word += char;
    started = true;
  }
  endSegment();
  return segments;
}

const LEADING_KEYWORDS: Record<string, true> = {
  do: true,
  then: true,
  else: true,
  elif: true,
  time: true,
  "!": true,
  "{": true,
};

/** Drop shell keywords and `VAR=value` prefixes in front of the program. */
function programWords(words: string[]): string[] {
  let index = 0;
  while (
    index < words.length &&
    (LEADING_KEYWORDS[words[index]] === true ||
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]))
  ) {
    index += 1;
  }
  return words.slice(index);
}

function validBranch(name: string | undefined): name is string {
  return (
    !!name &&
    /^[A-Za-z0-9._/+#-]+$/.test(name) &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock") &&
    !name.includes("..") &&
    !name.includes("//") &&
    name !== "HEAD"
  );
}

/** Value of `-b name`, `-bname`, or `--create=name`; `undefined` when the flag is absent. */
function optionValue(
  args: string[],
  index: number,
  short: readonly string[],
  long: readonly string[],
): { value: string | undefined } | undefined {
  const arg = args[index];
  if (short.includes(arg) || long.includes(arg)) {
    return { value: args[index + 1] };
  }
  for (const flag of long) {
    if (arg.startsWith(`${flag}=`)) return { value: arg.slice(flag.length + 1) };
  }
  for (const flag of short) {
    if (arg.startsWith(flag) && arg.length > flag.length) {
      return { value: arg.slice(flag.length) };
    }
  }
  return undefined;
}

function firstOptionValue(
  args: string[],
  short: readonly string[],
  long: readonly string[],
): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--") return undefined;
    const match = optionValue(args, index, short, long);
    if (match) return match.value;
  }
  return undefined;
}

const GIT_GLOBAL_VALUE_OPTIONS: Record<string, true> = {
  "-C": true,
  "-c": true,
  "--git-dir": true,
  "--work-tree": true,
  "--namespace": true,
  "--exec-path": true,
};

const BRANCH_CREATE_OPTIONS: Record<string, true> = {
  "-f": true,
  "--force": true,
  "-t": true,
  "--track": true,
  "--no-track": true,
  "-q": true,
  "--quiet": true,
};

function worktreeAddBranch(args: string[]): string | undefined {
  const positional: string[] = [];
  let detached = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const created = optionValue(args, index, ["-b", "-B"], ["--orphan"]);
    if (created) return validBranch(created.value) ? created.value : undefined;
    if (arg === "-d" || arg === "--detach") {
      detached = true;
    } else if (arg === "--reason") {
      index += 1;
    } else if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }
  if (detached) return undefined;
  const [path, commitish] = positional;
  if (commitish !== undefined) {
    // A local branch name, not a remote-tracking ref, SHA, or revision.
    return validBranch(commitish) &&
      !/^(?:origin|upstream)\//.test(commitish) &&
      !commitish.startsWith("refs/") &&
      !/^[0-9a-f]{7,40}$/.test(commitish)
      ? commitish
      : undefined;
  }
  // Without a commit-ish, git names the new branch after the worktree folder.
  const folder = path?.replace(/\/+$/, "").split("/").pop();
  return validBranch(folder) ? folder : undefined;
}

type SegmentFacts = {
  created?: string;
  deleted?: string[];
  createsPullRequest?: boolean;
};

function gitSegmentFacts(args: string[]): SegmentFacts | undefined {
  let index = 0;
  while (index < args.length && args[index].startsWith("-")) {
    index += GIT_GLOBAL_VALUE_OPTIONS[args[index]] === true ? 2 : 1;
  }
  const subcommand = args[index];
  const rest = args.slice(index + 1);
  if (subcommand === "checkout") {
    const created = firstOptionValue(rest, ["-b", "-B"], ["--orphan"]);
    return validBranch(created) ? { created } : undefined;
  }
  if (subcommand === "switch") {
    const created = firstOptionValue(
      rest,
      ["-c", "-C"],
      ["--create", "--force-create", "--orphan"],
    );
    return validBranch(created) ? { created } : undefined;
  }
  if (subcommand === "worktree" && rest[0] === "add") {
    const created = worktreeAddBranch(rest.slice(1));
    return created ? { created } : undefined;
  }
  if (subcommand === "branch") {
    const options = rest.filter((arg) => arg.startsWith("-"));
    const names = rest.filter((arg) => !arg.startsWith("-"));
    if (
      options.some((arg) => arg === "-d" || arg === "-D" || arg === "--delete")
    ) {
      return { deleted: names.filter(validBranch) };
    }
    if (
      names.length > 0 &&
      options.every((arg) => BRANCH_CREATE_OPTIONS[arg] === true) &&
      validBranch(names[0])
    ) {
      return { created: names[0] };
    }
  }
  return undefined;
}

function ghSegmentFacts(args: string[]): SegmentFacts | undefined {
  if (args[0] !== "pr" || args[1] !== "create") return undefined;
  // `--head owner:branch` targets a fork; the branch is the part after the colon.
  const head = firstOptionValue(args.slice(2), ["-H"], ["--head"])?.replace(
    /^[^:]*:/,
    "",
  );
  return { createsPullRequest: true, ...(validBranch(head) ? { created: head } : {}) };
}

function commandCandidates(block: Block): string[] {
  const preview = block.tool?.preview;
  const candidates = [
    preview?.kind === "shell" ? preview.title : undefined,
    block.tool?.title,
    block.text,
  ];
  return [
    ...new Set(
      candidates
        .map((value) => value?.trim().replace(/^Run(?:ning)?\s+command:\s*/i, ""))
        .filter((value): value is string => !!value),
    ),
  ];
}

function pullRequestUrls(output: string): SessionPullRequest[] {
  const found: SessionPullRequest[] = [];
  for (const match of output.matchAll(PR_URL_RE)) {
    const number = Number(match[3]);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    const repo = `${match[1]}/${match[2]}`;
    found.push({ repo, number, url: `https://github.com/${repo}/pull/${number}` });
  }
  return found;
}

function blockGitFacts(block: Block): BlockGitFacts {
  if (block.role !== "tool" || toolCallState(block) !== "accepted") {
    return NO_FACTS;
  }
  const cached = factsCache.get(block);
  if (cached) return cached;
  const created: string[] = [];
  const deleted: string[] = [];
  let createsPullRequest = false;
  for (const command of commandCandidates(block)) {
    for (const segment of commandSegments(command)) {
      const words = programWords(segment);
      const name = words[0]?.split("/").pop();
      const facts =
        name === "git"
          ? gitSegmentFacts(words.slice(1))
          : name === "gh"
            ? ghSegmentFacts(words.slice(1))
            : undefined;
      if (!facts) continue;
      if (facts.created) created.push(facts.created);
      if (facts.deleted) deleted.push(...facts.deleted);
      if (facts.createsPullRequest) createsPullRequest = true;
    }
  }
  const output = [block.tool?.detail, block.tool?.preview?.output]
    .filter(Boolean)
    .join("\n");
  const facts: BlockGitFacts =
    created.length || deleted.length || createsPullRequest
      ? {
          created,
          deleted,
          pullRequests: createsPullRequest ? pullRequestUrls(output) : [],
        }
      : NO_FACTS;
  // Running blocks change once they finish; only settled facts are cached.
  if (!block.streaming) factsCache.set(block, facts);
  return facts;
}

/**
 * Branches and pull requests created by completed tool calls in a transcript.
 * A branch deleted later (`git branch -d`) drops out; re-creating it moves it last.
 */
export function sessionGitActivity(blocks: readonly Block[]): SessionGitActivity {
  const branches = new Set<string>();
  const pullRequests = new Map<string, SessionPullRequest>();
  for (const block of blocks) {
    const facts = blockGitFacts(block);
    for (const name of facts.deleted) branches.delete(name);
    for (const name of facts.created) {
      branches.delete(name);
      branches.add(name);
    }
    for (const pr of facts.pullRequests) {
      const key = `${pr.repo.toLowerCase()}#${pr.number}`;
      if (!pullRequests.has(key)) pullRequests.set(key, pr);
    }
  }
  return { branches: [...branches], pullRequests: [...pullRequests.values()] };
}
