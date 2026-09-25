import type { Session } from "./session";
import { lastTurnUserBlock } from "./sessionRecap";

/** The settled, successful last turn still waiting for a recap, ignoring whether the user is active. */
function pendingRecapTurn(session: Session, settled: ReadonlySet<string>): string | null {
  // Workers report to their lead; leads get recaps like any other session.
  if (session.orchestrationLeadId) return null;
  const user = lastTurnUserBlock(session.blocks);
  if (!user || user.recap || user.durationMs == null || !settled.has(user.id)) return null;
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
