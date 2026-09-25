// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as TauriCore from "@tauri-apps/api/core";
import type * as Platform from "../../../platform/tauri/platform";
import { Composer } from "../../sessions/ui/Composer";
import { saveDictationSettings } from "../model/dictation";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof TauriCore>()),
  invoke: mocks.invoke,
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("../../../platform/tauri/platform", async (original) => ({
  ...(await original<typeof Platform>()),
  IS_MAC: true,
}));
vi.mock("../model/recorder", () => ({
  startDictationRecording: async () => ({
    stop: mocks.stop,
    cancel: mocks.cancel,
  }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function renderComposer(initialDraft: string) {
  await act(async () =>
    root.render(
      createElement(Composer, {
        focused: false,
        harness: "codex",
        model: "",
        runtimeMode: "supervised",
        executionCwd: "~",
        initialDraft,
        hideTopBar: true,
        onFocus: vi.fn(),
        onCwdChange: vi.fn(),
        onModelChange: vi.fn(),
        onRuntimeModeChange: vi.fn(),
        onSubmit: vi.fn(),
      }),
    ),
  );
}

const micButton = () =>
  container.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]');

it("shows the mic only while a model is set, releasing a live take", async () => {
  await renderComposer("");
  expect(micButton()).toBeNull();
  await act(async () => saveDictationSettings({ model: "/m/ggml.bin" }));
  await act(async () => micButton()!.click());
  expect(mocks.cancel).not.toHaveBeenCalled();
  await act(async () => saveDictationSettings({ model: null }));
  expect(mocks.cancel).toHaveBeenCalledOnce();
  expect(
    container.querySelector('button[aria-label="Stop dictation"]'),
  ).toBeNull();
});

it("inserts the corrected transcript at the caret", async () => {
  saveDictationSettings({
    model: "/m/ggml.bin",
    language: "pt",
    corrections: "mono code => MonoCode",
  });
  mocks.stop.mockResolvedValue(new Float32Array([0.1, -0.2]));
  mocks.invoke.mockImplementation(async (command: string) =>
    command === "dictation_transcribe" ? "abre o mono code" : undefined,
  );
  await renderComposer("Pede:depois");
  const textarea = container.querySelector("textarea")!;
  textarea.setSelectionRange(5, 5);

  await act(async () => micButton()!.click());
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Stop dictation"]')!
      .click(),
  );

  expect(textarea.value).toBe("Pede: abre o MonoCode depois");
  const call = mocks.invoke.mock.calls.find(
    ([command]) => command === "dictation_transcribe",
  )!;
  const options = new URLSearchParams(call[2].headers["x-dictation"]);
  expect(options.get("model")).toBe("/m/ggml.bin");
  expect(options.get("language")).toBe("pt");
});
