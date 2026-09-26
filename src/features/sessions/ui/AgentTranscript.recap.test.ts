// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../model/session";
import { AgentTranscript } from "./AgentTranscript";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const blocks: Block[] = [
  { id: "u1", role: "user", text: "oi", recap: "Ran `npm test`; all green." },
  { id: "a1", role: "assistant", text: "Olá" },
];

function recapLine() {
  return container.querySelector("[data-turn-recap]");
}

describe("AgentTranscript recap line", () => {
  it("shows the recap under a settled turn, with backticks as code", () => {
    act(() => root.render(createElement(AgentTranscript, { blocks, busy: false })));
    expect(recapLine()?.textContent).toBe("※ recap: Ran npm test; all green.");
    expect(recapLine()?.querySelector("code")?.textContent).toBe("npm test");
  });

  it("renders **bold** without the asterisks", () => {
    const bold: Block[] = [
      { ...blocks[0], recap: "Next: open **Financeiro → Cadastrar** and run `x`." },
      blocks[1],
    ];
    act(() => root.render(createElement(AgentTranscript, { blocks: bold, busy: false })));
    expect(recapLine()?.textContent).toBe("※ recap: Next: open Financeiro → Cadastrar and run x.");
    expect(recapLine()?.querySelector("strong")?.textContent).toBe("Financeiro → Cadastrar");
  });

  it("hides the recap while the last turn is still running", () => {
    act(() => root.render(createElement(AgentTranscript, { blocks, busy: true })));
    expect(recapLine()).toBeNull();
  });
});
