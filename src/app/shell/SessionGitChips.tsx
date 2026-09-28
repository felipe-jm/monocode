import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import type {
  SessionGitActivity,
  SessionPullRequest,
} from "../../features/sessions/model/sessionGitActivity";
import { copyText } from "../../platform/tauri/clipboard";
import { Popover } from "../../shared/ui/Popover";
import { Check, GitBranch, GitPullRequest } from "../../shared/ui/icons";

/** Newest items shown inline per kind; the rest sit behind the overflow menu. */
const INLINE_LIMIT = 2;
const COPIED_MS = 1200;

const CHIP =
  "-mx-0.5 inline-flex h-5 min-w-0 shrink-0 items-center gap-1 whitespace-nowrap rounded px-1 text-content/55 hover:bg-content/10 hover:text-content focus-visible:outline-2 focus-visible:outline-accent";
const MENU_ITEM =
  "flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] leading-none text-content hover:bg-content/10";

/** Branches and pull requests the agent created in this session. */
export function SessionGitChips({ activity }: { activity: SessionGitActivity }) {
  const { branches, pullRequests } = activity;
  const overflowRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (branches.length === 0 && pullRequests.length === 0) return null;

  // Qualify PR numbers with the repo only when the session touched several.
  const multiRepo =
    new Set(pullRequests.map((pr) => pr.repo.toLowerCase())).size > 1;
  const prLabel = (pr: SessionPullRequest) =>
    multiRepo ? `${pr.repo.split("/")[1]}#${pr.number}` : `#${pr.number}`;
  const copyBranch = (name: string) => {
    void copyText(name).then(() => setCopied(name));
  };
  const openPr = (pr: SessionPullRequest) => {
    void openUrl(pr.url).catch(() => undefined);
  };
  const inlineBranches = branches.slice(-INLINE_LIMIT);
  const inlinePrs = pullRequests.slice(-INLINE_LIMIT);
  const hidden =
    branches.length - inlineBranches.length +
    (pullRequests.length - inlinePrs.length);

  return (
    <div
      className="flex min-w-0 shrink-0 items-center gap-1.5"
      aria-label="Session branches and pull requests"
      role="group"
    >
      <span className="h-3 w-px shrink-0 bg-stroke" aria-hidden />
      {inlineBranches.map((name) => (
        <button
          key={`branch:${name}`}
          type="button"
          className={CHIP}
          aria-label={`Copy branch name ${name}`}
          title={copied === name ? "Copied" : `Copy branch name ${name}`}
          onClick={() => copyBranch(name)}
        >
          {copied === name ? (
            <Check className="size-3 shrink-0" strokeWidth={1.75} aria-hidden />
          ) : (
            <GitBranch className="size-3 shrink-0" strokeWidth={1.75} aria-hidden />
          )}
          <span className="max-w-[14rem] truncate">{name}</span>
        </button>
      ))}
      {inlinePrs.map((pr) => (
        <button
          key={`pr:${pr.url}`}
          type="button"
          className={CHIP}
          aria-label={`Open PR ${pr.repo}#${pr.number}`}
          title={`Open ${pr.repo}#${pr.number} on GitHub`}
          onClick={() => openPr(pr)}
        >
          <GitPullRequest className="size-3 shrink-0" strokeWidth={1.75} aria-hidden />
          <span className="tabular-nums">{prLabel(pr)}</span>
        </button>
      ))}
      {hidden > 0 ? (
        <button
          ref={overflowRef}
          type="button"
          className={`${CHIP} tabular-nums`}
          aria-label={`Show all ${branches.length + pullRequests.length} branches and pull requests`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((value) => !value)}
        >
          +{hidden}
        </button>
      ) : null}
      {menuOpen && hidden > 0 ? (
        <Popover
          anchor={overflowRef}
          side="top"
          align="start"
          autoFocus
          onDismiss={() => setMenuOpen(false)}
          role="menu"
          aria-label="Session branches and pull requests"
          className="min-w-[14rem] max-w-[24rem] p-1"
        >
          {branches.map((name) => (
            <button
              key={`branch:${name}`}
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              title={`Copy branch name ${name}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                copyBranch(name);
                setMenuOpen(false);
              }}
            >
              <GitBranch className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{name}</span>
            </button>
          ))}
          {pullRequests.map((pr) => (
            <button
              key={`pr:${pr.url}`}
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              title={pr.url}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                openPr(pr);
                setMenuOpen(false);
              }}
            >
              <GitPullRequest className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{pr.repo}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-content/40">
                #{pr.number}
              </span>
            </button>
          ))}
        </Popover>
      ) : null}
    </div>
  );
}
