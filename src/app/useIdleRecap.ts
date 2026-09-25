import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { serializeBtwSnapshot } from "../features/sessions/model/btw";
import { getComposerDraft } from "../features/sessions/model/draftCache";
import { recapFireAction, recapTarget } from "../features/sessions/model/idleRecap";
import {
  sessionDisplayTitle,
  sessionWorkCwd,
  type Session,
} from "../features/sessions/model/session";
import {
  applySessionRecap,
  buildSessionRecapPrompt,
  lastTurnUserBlock,
  parseSessionRecap,
} from "../features/sessions/model/sessionRecap";
import {
  selectedProviderAccountId,
  supportsProviderAccounts,
} from "../features/providers/model/providerAccounts";
import {
  loadAutoTitles,
  loadIdleRecap,
  loadIdleRecapSeconds,
} from "../features/settings/model/settings";
import {
  canRunHarnessTextPrompt,
  runHarnessTextPrompt,
} from "../integrations/harness/core/registry";
import { pickTextHarness } from "../integrations/harness/core/textHarness";

const RECAP_TIMEOUT_MS = 60_000;

type Timer = { key: string; handle: number; abort?: AbortController };

/** Arms one idle timer per session whose last turn settled in this app run. */
export function useIdleRecap(input: {
  sessions: Session[];
  sessionsRef: { current: Session[] };
  setSessions: Dispatch<SetStateAction<Session[]>>;
}) {
  const { sessions, sessionsRef, setSessions } = input;
  const wasBusy = useRef(new Map<string, boolean>());
  const settled = useRef(new Set<string>());
  const timers = useRef(new Map<string, Timer>());

  useEffect(() => {
    const enabled = loadIdleRecap();
    const live = new Set<string>();
    for (const session of sessions) {
      live.add(session.id);
      if (wasBusy.current.get(session.id) && !session.busy) {
        const last = lastTurnUserBlock(session.blocks);
        if (last) settled.current.add(last.id);
      }
      wasBusy.current.set(session.id, !!session.busy);

      // Typing a draft does not re-render sessions, so the timer ignores it
      // here and the fire check waits for the composer to clear instead.
      const target = enabled
        ? recapTarget(session, settled.current, undefined)
        : null;
      const key = target ? `${session.id}:${target}` : "";
      const current = timers.current.get(session.id);
      if (current && current.key === key) continue;
      if (current) {
        window.clearTimeout(current.handle);
        current.abort?.abort();
        timers.current.delete(session.id);
      }
      if (!target) continue;
      const timer: Timer = { key, handle: 0 };
      arm(session.id, target, timer);
      timers.current.set(session.id, timer);
    }
    for (const [id, timer] of timers.current) {
      if (live.has(id)) continue;
      window.clearTimeout(timer.handle);
      timer.abort?.abort();
      timers.current.delete(id);
    }
    for (const id of wasBusy.current.keys()) {
      if (!live.has(id)) wasBusy.current.delete(id);
    }
  }, [sessions]);

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) {
        window.clearTimeout(timer.handle);
        timer.abort?.abort();
      }
    },
    [],
  );

  function arm(sessionId: string, userBlockId: string, timer: Timer) {
    timer.handle = window.setTimeout(() => {
      void fire(sessionId, userBlockId, timer);
    }, loadIdleRecapSeconds() * 1000);
  }

  /** The armed turn's session when it should still get a recap; null drops it. */
  function pendingRecap(
    sessionId: string,
    userBlockId: string,
  ): { session: Session; action: "run" | "wait" } | null {
    const session = sessionsRef.current.find((s) => s.id === sessionId);
    if (!session || !loadIdleRecap()) return null;
    const action = recapFireAction(
      session,
      settled.current,
      getComposerDraft(sessionId),
      userBlockId,
    );
    return action === "drop" ? null : { session, action };
  }

  async function fire(sessionId: string, userBlockId: string, timer: Timer) {
    const pending = pendingRecap(sessionId, userBlockId);
    if (!pending) return;
    if (pending.action === "wait") {
      // The user is still active in this session: try again after a full delay.
      arm(sessionId, userBlockId, timer);
      return;
    }
    const { session } = pending;
    const lastBlock = session.blocks[session.blocks.length - 1];
    const harness = canRunHarnessTextPrompt(session.harness)
      ? session.harness
      : pickTextHarness(session.harness);
    timer.abort = new AbortController();
    try {
      const cwd = sessionWorkCwd(session);
      const raw = await runHarnessTextPrompt({
        harness,
        cwd,
        // Same account choice as the first-turn title for this harness.
        providerAccountId:
          harness === session.harness && supportsProviderAccounts(harness)
            ? (session.providerAccountId ??
              selectedProviderAccountId(harness, session.cwd))
            : undefined,
        prompt: buildSessionRecapPrompt({
          transcript: serializeBtwSnapshot(session.blocks, lastBlock.id, cwd),
          currentTitle: sessionDisplayTitle(session.title, session.harness),
        }),
        timeoutMs: RECAP_TIMEOUT_MS,
        signal: timer.abort.signal,
      });
      const result = parseSessionRecap(raw);
      if (!result) {
        console.warn("[monocode] idle recap: unreadable output", harness);
        return;
      }
      // A draft typed meanwhile does not make the recap wrong; a new turn,
      // an existing recap, or the setting turned off does.
      if (!pendingRecap(sessionId, userBlockId)) return;
      const allowTitle = loadAutoTitles();
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? applySessionRecap(s, userBlockId, result, allowTitle)
            : s,
        ),
      );
    } catch (error) {
      if (!timer.abort.signal.aborted)
        console.warn("[monocode] idle recap failed", harness, error);
    }
  }
}
