import { describe, expect, it } from "vitest";
import { newSession, type Session } from "./session";
import { recapFireAction, recapTarget } from "./idleRecap";

function session(overrides: Partial<Session> = {}): Session {
  return {
    ...newSession("omp", "/tmp/p"),
    blocks: [
      { id: "u1", role: "user", text: "suba o nginx", durationMs: 1000 },
      { id: "a1", role: "assistant", text: "feito" },
    ],
    ...overrides,
  } as Session;
}
const settled = new Set(["u1"]);

describe("recapTarget", () => {
  it("targets the settled last turn", () => {
    expect(recapTarget(session(), settled, undefined)).toBe("u1");
  });
  it("ignores turns not settled this run", () => {
    expect(recapTarget(session(), new Set(), undefined)).toBeNull();
  });
  it("waits while busy or while a draft is typed", () => {
    expect(recapTarget(session({ busy: true }), settled, undefined)).toBeNull();
    expect(recapTarget(session(), settled, "half typed")).toBeNull();
  });
  it("skips a turn that already has a recap", () => {
    const s = session();
    s.blocks[0] = { ...s.blocks[0], recap: "x" };
    expect(recapTarget(s, settled, undefined)).toBeNull();
  });
  it("skips interrupted and failed turns", () => {
    for (const notice of ["interrupt", "error"] as const) {
      const s = session();
      s.blocks.push({ id: "n", role: "system", text: "stopped", notice });
      expect(recapTarget(s, settled, undefined)).toBeNull();
    }
  });
  it("skips orchestration workers", () => {
    expect(recapTarget(session({ orchestrationLeadId: "lead" }), settled, undefined)).toBeNull();
  });
});

describe("recapFireAction", () => {
  it("runs when the armed turn is still the idle target", () => {
    expect(recapFireAction(session(), settled, undefined, "u1")).toBe("run");
  });
  it("waits while busy or while a draft is typed", () => {
    expect(recapFireAction(session({ busy: true }), settled, undefined, "u1")).toBe("wait");
    expect(recapFireAction(session(), settled, "half typed", "u1")).toBe("wait");
    expect(recapFireAction(session(), settled, "   ", "u1")).toBe("run");
  });
  it("drops when a new turn replaced the armed one", () => {
    const s = session();
    s.blocks.push({ id: "u2", role: "user", text: "e agora?", durationMs: 500 });
    expect(recapFireAction(s, new Set(["u1", "u2"]), undefined, "u1")).toBe("drop");
  });
  it("drops when the turn already has a recap, even while a draft is typed", () => {
    const s = session();
    s.blocks[0] = { ...s.blocks[0], recap: "x" };
    expect(recapFireAction(s, settled, "half typed", "u1")).toBe("drop");
  });
});
