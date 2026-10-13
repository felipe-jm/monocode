// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentMarkdown } from "./AgentMarkdown";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  convertFileSrc: (path: string) => path,
}));

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args: { path: string }) => {
    if (command !== "read_binary_file") throw new Error(command);
    if (args.path.endsWith("missing.png")) throw new Error("No such file");
    if (args.path.endsWith("fake.png")) return new TextEncoder().encode("<html>").buffer;
    return PNG.buffer;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(text: string, extra: Record<string, unknown> = {}) {
  await act(async () =>
    root.render(createElement(AgentMarkdown, { text, cwd: "/work/app", ...extra })),
  );
  await act(async () => undefined);
}

function readPaths(): string[] {
  return invoke.mock.calls.map(([, args]) => (args as { path: string }).path);
}

it("shows an `<image: path>` marker as a thumbnail that opens full screen", async () => {
  await render("Segue o print:\n\n<image: /tmp/gc-preview.png>\n\nO que mudou");

  expect(readPaths()).toEqual(["/tmp/gc-preview.png"]);
  expect(container.textContent).not.toContain("<image:");
  const thumb = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Open gc-preview.png full screen"]',
  )!;
  expect(thumb.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/);

  act(() => thumb.click());
  expect(
    document.querySelector('[role="dialog"][aria-label="Image preview: gc-preview.png"]'),
  ).not.toBeNull();
});

it("resolves relative Markdown image paths against the session cwd", async () => {
  await render("![chart](shots/chart.png)");

  expect(readPaths()).toEqual(["/work/app/shots/chart.png"]);
  expect(
    container.querySelector('button[aria-label="Open chart full screen"]'),
  ).not.toBeNull();
});

it("keeps markers inside code literal and skips non-image paths", async () => {
  await render("`<image: /tmp/a.png>`\n\n![notes](/tmp/notes.txt)");

  expect(invoke).not.toHaveBeenCalled();
  expect(container.querySelector("code")?.textContent).toBe("<image: /tmp/a.png>");
});

it("labels a missing file or bytes that are not an image", async () => {
  await render("<image: /tmp/missing.png> <image: /tmp/fake.png>");

  const failures = [
    ...container.querySelectorAll('[data-local-image="failed"]'),
  ].map((node) => node.textContent);
  expect(failures).toEqual([
    "Couldn’t load image: /tmp/missing.png",
    "Couldn’t load image: /tmp/fake.png",
  ]);
  expect(container.querySelector("img")).toBeNull();
});

it("never reads local files for remote Inbox content", async () => {
  await render("![x](/tmp/secret.png) <image: /tmp/secret.png>", {
    allowRemoteMedia: true,
  });

  expect(invoke).not.toHaveBeenCalled();
});
