import { describe, expect, it } from "vitest";
import { newSession, type Session } from "./session";
import {
  applySessionRecap,
  buildSessionRecapPrompt,
  parseSessionRecap,
} from "./sessionRecap";

function withTurn(overrides: Partial<Session> = {}): Session {
  return {
    ...newSession("omp", "/tmp/p"),
    title: "omp · Deploy nginx",
    blocks: [
      { id: "u1", role: "user", text: "suba o nginx", durationMs: 1000 },
      { id: "a1", role: "assistant", text: "feito" },
    ],
    ...overrides,
  } as Session;
}

describe("parseSessionRecap", () => {
  it("reads JSON inside a code fence", () => {
    const raw = '```json\n{"recap":"Nginx no ar. Próximo passo: DNS.","title":"Deploy nginx e DNS","titleChanged":true}\n```';
    expect(parseSessionRecap(raw)).toEqual({
      recap: "Nginx no ar. Próximo passo: DNS.",
      title: "Deploy nginx e DNS",
      titleChanged: true,
    });
  });

  it("rejects output without a recap", () => {
    expect(parseSessionRecap('{"title":"x","titleChanged":false}')).toBeNull();
    expect(parseSessionRecap("not json")).toBeNull();
  });

  it("caps the recap at 600 characters and collapses whitespace", () => {
    const parsed = parseSessionRecap(JSON.stringify({ recap: `a\n\n${"b".repeat(700)}`, title: "", titleChanged: false }));
    expect(parsed?.recap.length).toBe(600);
    expect(parsed?.recap.startsWith("a b")).toBe(true);
    expect(parsed?.title).toBeNull();
  });
});

describe("buildSessionRecapPrompt", () => {
  it("includes the transcript and current title", () => {
    const prompt = buildSessionRecapPrompt({ transcript: "User: oi", currentTitle: "Deploy nginx" });
    expect(prompt).toContain("User: oi");
    expect(prompt).toContain("Deploy nginx");
  });
});

describe("applySessionRecap", () => {
  const result = { recap: "Nginx no ar.", title: "Configurar DNS do café", titleChanged: true };

  it("stores the recap on the turn and refreshes an automatic title", () => {
    const next = applySessionRecap(withTurn(), "u1", result, true);
    expect(next.blocks[0].recap).toBe("Nginx no ar.");
    expect(next.title).toBe("omp · Configurar DNS do café");
  });

  it("keeps a user title", () => {
    const next = applySessionRecap(withTurn({ titleSource: "user" }), "u1", result, true);
    expect(next.title).toBe("omp · Deploy nginx");
    expect(next.blocks[0].recap).toBe("Nginx no ar.");
  });

  it("keeps the title when auto titles are off or the subject did not change", () => {
    expect(applySessionRecap(withTurn(), "u1", result, false).title).toBe("omp · Deploy nginx");
    expect(applySessionRecap(withTurn(), "u1", { ...result, titleChanged: false }, true).title)
      .toBe("omp · Deploy nginx");
  });

  it("ignores a stale turn", () => {
    const session = withTurn();
    session.blocks.push({ id: "u2", role: "user", text: "e agora?" });
    expect(applySessionRecap(session, "u1", result, true)).toBe(session);
  });
});
