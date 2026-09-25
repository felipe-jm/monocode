import type { Session } from "./session";
import { lastTurnUserBlock } from "./sessionRecap";

/** A session's busy state and the last real turn it showed while idle. */
export type TurnWatch = { busy: boolean; idleTurnId: string | undefined };

/**
 * Advance a session's busy watch. `settled` is the last turn when a busy
 * period just ended with a new real user turn; busy periods that start no
 * turn (compaction, internal orchestration nudges) settle nothing.
 */
export function watchTurnSettle(
  prev: TurnWatch | undefined,
  session: Session,
): { watch: TurnWatch; settled: string | undefined } {
  const turnId = lastTurnUserBlock(session.blocks)?.id;
  // The send flow appends the user block and sets busy in the same update,
  // so the baseline is the turn seen before the session went busy.
  if (session.busy) return { watch: { busy: true, idleTurnId: prev?.idleTurnId }, settled: undefined };
  const settled = prev?.busy && turnId !== prev.idleTurnId ? turnId : undefined;
  return { watch: { busy: false, idleTurnId: turnId }, settled };
}

/** The settled, successful last turn still waiting for a recap, ignoring whether the user is active. */
function pendingRecapTurn(session: Session, settled: ReadonlySet<string>): string | null {
  // Workers report to their lead and Inbox Ask chats are throwaway; leads get
  // recaps like any other session.
  if (session.orchestrationLeadId || session.inboxAsk) return null;
  const user = lastTurnUserBlock(session.blocks);
  // No `durationMs` check: steered turns never record one, and `settled`
  // already proves this run saw the turn go busy and come back idle.
  if (!user || user.recap || !settled.has(user.id)) return null;
  const index = session.blocks.indexOf(user);
  const failed = session.blocks
    .slice(index + 1)
    .some((block) => block.role === "system" && (block.notice === "interrupt" || block.notice === "error"));
  return failed ? null : user.id;
}

/** User block id to recap now, or null when the session should not get one. */
export function recapTarget(
  session: Session,
  settled: ReadonlySet<string>,
  draft: string | undefined,
): string | null {
  if (session.busy || draft?.trim()) return null;
  return pendingRecapTurn(session, settled);
}

/**
 * What an idle timer armed for `userBlockId` should do when it fires: run the
 * recap, wait another delay while the user is active, or drop it for good.
 */
export function recapFireAction(
  session: Session,
  settled: ReadonlySet<string>,
  draft: string | undefined,
  userBlockId: string,
): "run" | "wait" | "drop" {
  if (pendingRecapTurn(session, settled) !== userBlockId) return "drop";
  return session.busy || draft?.trim() ? "wait" : "run";
}
