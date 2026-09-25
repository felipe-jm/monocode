// @vitest-environment happy-dom
import { act, createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setComposerDraft } from "../features/sessions/model/draftCache";
import { newSession, type Session } from "../features/sessions/model/session";

const registry = vi.hoisted(() => ({ run: vi.fn<(input: unknown) => Promise<string>>() }));
vi.mock("../integrations/harness/core/registry", () => ({
  canRunHarnessTextPrompt: () => true,
  runHarnessTextPrompt: registry.run,
}));

import { useIdleRecap } from "./useIdleRecap";

const IDLE_MS = 240_000;
const RECAP = JSON.stringify({ recap: "Nginx is up; next: test TLS.", title: "Nginx TLS", titleChanged: false });

let root: Root;
let latest: Session[];
let setSessions: (update: (sessions: Session[]) => Session[]) => void;
const base: Session = { ...newSession("omp", "/tmp/p"), blocks: [] };

function Host() {
  const [sessions, set] = useState([base]);
  const ref = useRef(sessions);
  ref.current = sessions;
  latest = sessions;
  setSessions = set;
  useIdleRecap({ sessions, sessionsRef: ref, setSessions: set });
  return null;
}

async function runTurn() {
  await act(async () =>
    setSessions((all) =>
      all.map((s) => ({ ...s, busy: true, blocks: [{ id: "u1", role: "user", text: "start nginx" }] })),
    ),
  );
  await act(async () =>
    setSessions((all) =>
      all.map((s) => ({
        ...s,
        busy: false,
        blocks: [
          { id: "u1", role: "user", text: "start nginx", durationMs: 900 },
          { id: "a1", role: "assistant", text: "done" },
        ],
      })),
    ),
  );
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  registry.run.mockReset();
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Host)));
});

afterEach(() => {
  act(() => root.unmount());
  setComposerDraft(base.id, "");
  vi.useRealTimers();
});

it("drops a recap whose generation finished while a draft appeared, then retries after the draft clears", async () => {
  let finish!: (raw: string) => void;
  registry.run.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  await runTurn();
  await act(async () => vi.advanceTimersByTime(IDLE_MS));
  expect(registry.run).toHaveBeenCalledTimes(1);

  setComposerDraft(base.id, "half typed");
  await act(async () => finish(RECAP));
  expect(latest[0].blocks[0].recap).toBeUndefined();

  setComposerDraft(base.id, "");
  registry.run.mockResolvedValueOnce(RECAP);
  await act(async () => vi.advanceTimersByTime(IDLE_MS));
  expect(registry.run).toHaveBeenCalledTimes(2);
  expect(latest[0].blocks[0].recap).toBe("Nginx is up; next: test TLS.");
});

it("does not recap an old turn after a busy period without a new user turn", async () => {
  registry.run.mockResolvedValue(RECAP);
  await act(async () =>
    setSessions((all) =>
      all.map((s) => ({
        ...s,
        blocks: [
          { id: "u1", role: "user", text: "start nginx", durationMs: 900 },
          { id: "a1", role: "assistant", text: "done" },
        ],
      })),
    ),
  );
  await act(async () => setSessions((all) => all.map((s) => ({ ...s, busy: true }))));
  await act(async () => setSessions((all) => all.map((s) => ({ ...s, busy: false }))));
  await act(async () => vi.advanceTimersByTime(IDLE_MS * 3));
  expect(registry.run).not.toHaveBeenCalled();
});
