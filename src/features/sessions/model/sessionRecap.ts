import { extractJsonObject, limitSection } from "../../../shared/lib/jsonText";
import { formatSessionTitle, type Block, type Session } from "./session";
import { sanitizeThreadTitle } from "./sessionTitle";

const RECAP_LIMIT = 600;
const TRANSCRIPT_LIMIT = 24_000;

const RECAP_PROMPT = `You write a recap for a developer returning to this coding session after a break.
Return JSON with exactly three keys: recap, title, titleChanged. Do not call tools. Reply with JSON only.

recap: 1-3 sentences in the same language as the user's messages. Say what is being worked on, where it stands now (done, blocked, waiting on the user), and end with the concrete next step. Name files, commands, PRs, and systems exactly as they appear. No greetings, no bullet points.
title: a 3-8 word title for the session as it is now, fewer than 40 characters, same language as the current title. Compact noun or action phrase; no quotes or trailing punctuation.
titleChanged: true only when the session's subject has clearly moved away from the current title; false when the current title still fits.`;

export type SessionRecap = { recap: string; title: string | null; titleChanged: boolean };

export function buildSessionRecapPrompt(input: { transcript: string; currentTitle: string }): string {
  return `${RECAP_PROMPT}\n\nCurrent title: ${input.currentTitle}\n\nTranscript:\n${limitSection(input.transcript, TRANSCRIPT_LIMIT)}`;
}

export function parseSessionRecap(raw: string): SessionRecap | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const recap = typeof parsed.recap === "string"
      ? parsed.recap.replace(/\s+/g, " ").trim().slice(0, RECAP_LIMIT)
      : "";
    if (!recap) return null;
    const title = typeof parsed.title === "string" ? sanitizeThreadTitle(parsed.title) : "";
    return { recap, title: title || null, titleChanged: parsed.titleChanged === true };
  } catch {
    return null;
  }
}

/** The user block that opens the latest real turn. */
export function lastTurnUserBlock(blocks: Block[]): Block | undefined {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.role === "user" && !block.draft && !block.internal) return block;
  }
  return undefined;
}

export function applySessionRecap(
  session: Session,
  userBlockId: string,
  result: SessionRecap,
  allowTitle: boolean,
): Session {
  if (lastTurnUserBlock(session.blocks)?.id !== userBlockId) return session;
  const blocks = session.blocks.map((block) =>
    block.id === userBlockId ? { ...block, recap: result.recap } : block,
  );
  const retitle =
    allowTitle &&
    result.titleChanged &&
    result.title != null &&
    session.titleSource !== "user";
  const title = retitle ? formatSessionTitle(session.harness, result.title!) : session.title;
  return { ...session, blocks, title };
}
