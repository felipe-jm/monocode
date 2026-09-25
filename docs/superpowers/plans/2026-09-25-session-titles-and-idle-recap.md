# Smart session titles and idle recap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix omp/Pi first-turn titles, protect user-set titles, and add an idle `※ recap:` line that can also refresh an automatic title.

**Architecture:** Pure TS helpers (model ranking, recap prompt/parser/apply, idle target selection) carry the logic and the tests; `App.tsx` only wires them. Rust gains a `title_source` column (migration v19) and indexes the recap text. The recap is a field on the turn's user block, like `durationMs`.

**Tech Stack:** React 19 + TypeScript + Vitest (`npx vitest run <file>`), Tauri 2 + Rust + rusqlite (`cargo test -p <crate> session_store` from `src-tauri/`).

**Spec:** `docs/superpowers/specs/2026-09-25-session-titles-and-idle-recap-design.md`

## Global Constraints

- Idle delay default 240 s; allowed values 60, 120, 240, 300, 600.
- Recap: 1–3 sentences, conversation language, capped at 600 chars; rendered as `※ recap: <text>`, muted italic.
- Title: 3–8 words, `sanitizeThreadTitle` rules (50-char cap).
- A title with `titleSource === "user"` is never changed automatically.
- Settings keys: `monocode.autoTitles` (default on), `monocode.idleRecap` (default on), `monocode.idleRecapSeconds` (default 240). Read at call time; no change events.
- The recap text never reaches the agent, `/btw`, or handoff prompts.
- Only one retry with the next model candidate; timeouts and aborts never retry.

## Review Focus

- App restart with old sessions: no recap may fire for turns that did not settle in this app run (Task 6 test "ignores turns not settled this run").
- User types in the composer while the recap request is in flight: the result is dropped if the draft is non-empty or the session went busy (Task 6 test "drops result when a draft appeared").
- A new turn starts before the recap returns: the recap must not attach to the new turn (Task 4 test "ignores a stale turn").
- Renamed session receives a recap with `titleChanged: true`: title stays (Task 4 test "keeps a user title").
- Catalog without any cheap model, or empty catalog: omp still runs with its default model (Task 1 test "returns [] for an empty catalog").

---

### Task 1: Rank omp/Pi text models and retry once

**Files:**
- Create: `src/integrations/harness/providers/pi/piTextModels.ts`
- Create: `src/integrations/harness/providers/pi/piTextModels.test.ts`
- Modify: `src/integrations/harness/providers/pi/piText.ts` (`pickTextModel` :54-69, `runTextPrompt` :90-110, `promptOnLive` :112-128, `ensureLive` :204-225)
- Modify: `src/integrations/harness/providers/pi/piTitle.ts:26-28`

**Interfaces:**
- Produces: `rankPiTextModels(models: AgentModel[], requested?: string): string[]`; `runWithFallback<T>(candidates: (string | undefined)[], attempt: (model: string | undefined) => Promise<T>, retryable: (error: unknown) => boolean): Promise<T>`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from "vitest";
import type { AgentModel } from "../../../../features/sessions/model/models";
import { rankPiTextModels, runWithFallback } from "./piTextModels";

const m = (nativeId: string, name = nativeId): AgentModel => ({
  id: `omp:${nativeId}`,
  harness: "omp",
  name,
  nativeId,
});

describe("rankPiTextModels", () => {
  it("prefers the newest cheap model over an older dated snapshot", () => {
    const catalog = [
      m("anthropic/claude-3-haiku-20240307", "Claude Haiku 3"),
      m("anthropic/claude-haiku-4-5-20251001", "Claude Haiku 4.5 (20251001)"),
      m("anthropic/claude-haiku-4-5", "Claude Haiku 4.5"),
      m("anthropic/claude-opus-5-5", "Claude Opus 5.5"),
    ];
    expect(rankPiTextModels(catalog)).toEqual([
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-haiku-4-5-20251001",
      "anthropic/claude-3-haiku-20240307",
    ]);
  });

  it("keeps an explicit provider/model request", () => {
    expect(rankPiTextModels([m("a/haiku-9")], "x/custom")).toEqual(["x/custom"]);
  });

  it("falls back to the first catalog model when nothing is cheap", () => {
    expect(rankPiTextModels([m("a/opus-5"), m("a/sonnet-5")])).toEqual(["a/opus-5"]);
  });

  it("returns [] for an empty catalog", () => {
    expect(rankPiTextModels([])).toEqual([]);
  });
});

describe("runWithFallback", () => {
  it("retries once with the next candidate on a retryable error", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error("404 not_found_error"))
      .mockResolvedValueOnce("OK");
    await expect(runWithFallback(["a", "b", "c"], attempt, () => true)).resolves.toBe("OK");
    expect(attempt.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
  });

  it("does not retry a non-retryable error", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error("timed out"));
    await expect(runWithFallback(["a", "b"], attempt, () => false)).rejects.toThrow("timed out");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("stops after one retry", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(runWithFallback(["a", "b", "c"], attempt, () => true)).rejects.toThrow("boom");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("runs once with undefined when there are no candidates", async () => {
    const attempt = vi.fn().mockResolvedValue("OK");
    await runWithFallback([], attempt, () => true);
    expect(attempt).toHaveBeenCalledWith(undefined);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/integrations/harness/providers/pi/piTextModels.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `piTextModels.ts`**

```ts
import type { AgentModel } from "../../../../features/sessions/model/models";

const CHEAP = /haiku|mini|flash|nano|lite|luna/i;
const DATE_SUFFIX = /-\d{8}$/;

function versionKey(nativeId: string): { version: number[]; dated: boolean } {
  const bare = nativeId.slice(nativeId.indexOf("/") + 1);
  const dated = DATE_SUFFIX.test(bare);
  const version = (bare.replace(DATE_SUFFIX, "").match(/\d+/g) ?? []).map(Number);
  return { version, dated };
}

function compareNewestFirst(a: string, b: string): number {
  const left = versionKey(a);
  const right = versionKey(b);
  const length = Math.max(left.version.length, right.version.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (right.version[i] ?? 0) - (left.version[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return Number(left.dated) - Number(right.dated);
}

/** Text-model candidates, best first. Empty means "let the CLI pick". */
export function rankPiTextModels(models: AgentModel[], requested?: string): string[] {
  const selected = requested?.trim();
  if (selected?.includes("/")) return [selected];
  const ids = models
    .map((model) => ({ model, id: model.nativeId?.trim() ?? "" }))
    .filter(({ id }) => id.includes("/"));
  const cheap = ids
    .filter(({ model, id }) => CHEAP.test(`${id} ${model.name} ${model.id}`))
    .map(({ id }) => id)
    .sort(compareNewestFirst);
  if (cheap.length > 0) return cheap;
  return ids.length > 0 ? [ids[0].id] : [];
}

/** Try the first candidate; on a retryable failure try the next one once. */
export async function runWithFallback<T>(
  candidates: (string | undefined)[],
  attempt: (model: string | undefined) => Promise<T>,
  retryable: (error: unknown) => boolean,
): Promise<T> {
  const [first, second] = candidates.length > 0 ? candidates : [undefined];
  try {
    return await attempt(first);
  } catch (error) {
    if (candidates.length < 2 || !retryable(error)) throw error;
    console.warn("[monocode] text model failed, retrying", first, error);
    return attempt(second);
  }
}
```

- [ ] **Step 4: Run tests — PASS.**

- [ ] **Step 5: Wire into `piText.ts`**

Delete `pickTextModel` (:54-69). Change `ensureLive(flavor, cwd, model, modelSettings)` so its third parameter is the already-resolved model (`const model = requestedModel;` instead of `pickTextModel(...)`). `warmupText` passes `rankPiTextModels(modelsFor(flavor.id))[0]`.

Replace the body of `runTextPrompt` so each queued run goes through the fallback:

```ts
  const candidates = rankPiTextModels(modelsFor(flavor.id), input.model);
  const run = state.turns
    .catch(() => undefined)
    .then(() =>
      runWithFallback(
        candidates,
        (model) => promptOnLive(flavor, { ...input, model }),
        (error) =>
          !input.signal?.aborted &&
          !(error instanceof Error && /timed out|cancelled/i.test(error.message)),
      ),
    );
```

In `promptOnLive` keep `ensureLive(flavor, input.cwd, input.model, input.modelSettings)` — `input.model` is now the resolved candidate.

In `piTitle.ts:27` replace `console.debug` with `console.warn("[monocode] session title failed", flavor.id, error);`.

- [ ] **Step 6: Run** `npx vitest run src/integrations/harness/providers/pi` — PASS; `npx tsc --noEmit` — clean.

- [ ] **Step 7: Commit**

```bash
git add src/integrations/harness/providers/pi
git commit -m "Pick the newest cheap omp and Pi text model and retry once on failure"
```

---

### Task 2: `title_source` column in Rust

**Files:**
- Modify: `src-tauri/src/session_store.rs` (structs :75-176, `migrate` after v18 :723, `upsert_session` :959-1010, `get_session` :1559+, `block_texts` :1213, tests module)

**Interfaces:**
- Produces: `SessionUpsert.title_source: Option<String>` (serde `titleSource`, default `None` = `auto`); `SessionRecord.title_source: Option<String>` (`Some("user")` only). Column `sessions.title_source TEXT NOT NULL DEFAULT 'auto'`. `block_texts` includes a block's `recap`.

- [ ] **Step 1: Write failing tests** (in the existing `mod tests`, using `sample`)

```rust
    #[test]
    fn title_source_round_trips() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let mut row = sample("s1", "/tmp/a", "omp · Named by me");
        row.title_source = Some("user".into());
        upsert_session(&conn, &row).unwrap();
        assert_eq!(get_session(&conn, "s1").unwrap().unwrap().title_source.as_deref(), Some("user"));
        row.title_source = None;
        upsert_session(&conn, &row).unwrap();
        assert_eq!(get_session(&conn, "s1").unwrap().unwrap().title_source, None);
    }

    #[test]
    fn title_source_backfill_marks_only_non_placeholder_titles() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let first = json!([{ "id": "u1", "role": "user", "text": "Fix the login bug\nmore" }]);
        let rows = [
            ("a", "omp · Fix the login bug", "auto"),       // seed
            ("b", "omp", "auto"),                           // bare label
            ("c", "omp · Login fix after deploy", "user"),  // LLM or renamed
        ];
        for (id, title, _) in rows {
            let mut row = sample(id, "/tmp/a", title);
            row.blocks = first.clone();
            upsert_session(&conn, &row).unwrap();
        }
        conn.execute("UPDATE sessions SET title_source = 'auto'", []).unwrap();
        backfill_title_source(&conn).unwrap();
        for (id, _, expected) in rows {
            let source: String = conn
                .query_row("SELECT title_source FROM sessions WHERE id = ?1", [id], |r| r.get(0))
                .unwrap();
            assert_eq!(source, expected, "{id}");
        }
    }

    #[test]
    fn title_source_backfill_truncates_like_the_client() {
        let long = "x".repeat(80);
        assert_eq!(placeholder_seed(&json!([{ "role": "user", "text": long }])),
                   Some(format!("{}…", "x".repeat(71))));
    }

    #[test]
    fn search_finds_recap_text() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let mut row = sample("s1", "/tmp/a", "omp · A");
        row.blocks = json!([{ "id": "u1", "role": "user", "text": "hi", "recap": "Deploy do nginx pendente" }]);
        upsert_session(&conn, &row).unwrap();
        assert!(block_texts(&row.blocks[0]).iter().any(|t| t.contains("nginx")));
    }
```

If `sample` builds `blocks` with a different type than `Value`, adapt the assignment to that type (check `sample` at :1705).

- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml title_source search_finds_recap` — FAIL (unknown field/fn).

- [ ] **Step 3: Implement**

Structs: add `#[serde(default)] pub title_source: Option<String>,` to `SessionUpsert` next to `title`; add `#[serde(skip_serializing_if = "Option::is_none")] pub title_source: Option<String>,` to `SessionRecord`. Fill `title_source: None` in `sample` and any other struct literal the compiler flags.

Helpers (next to `ensure_column`):

```rust
/// Mirrors `titleFromPrompt` in session.ts: the client's placeholder title text.
fn placeholder_seed(blocks: &Value) -> Option<String> {
    let first = blocks.as_array()?.iter().find(|b| b["role"] == "user")?;
    let text = first["text"].as_str().unwrap_or("");
    let line = text.trim().lines().next().unwrap_or("").trim().to_string();
    let seed = if line.is_empty() {
        first["attachments"].as_array().map(|files| {
            files.iter().filter_map(|f| f["name"].as_str()).filter(|n| !n.is_empty())
                .take(3).collect::<Vec<_>>().join(", ")
        }).unwrap_or_default()
    } else { line };
    if seed.is_empty() { return None; }
    let units: Vec<u16> = seed.encode_utf16().collect();
    if units.len() <= 72 { return Some(seed); }
    Some(format!("{}…", String::from_utf16_lossy(&units[..71])))
}

fn backfill_title_source(conn: &Connection) -> rusqlite::Result<()> {
    let rows: Vec<(String, String, String)> = conn
        .prepare("SELECT id, title, blocks_json FROM sessions WHERE title LIKE '% · %'")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (id, title, blocks) in rows {
        let suffix = title.split_once(" · ").map(|(_, rest)| rest).unwrap_or("");
        let blocks: Value = serde_json::from_str(&blocks).unwrap_or(Value::Null);
        if placeholder_seed(&blocks).as_deref() != Some(suffix) {
            conn.execute("UPDATE sessions SET title_source = 'user' WHERE id = ?1", [&id])?;
        }
    }
    Ok(())
}
```

Migration, after the `current < 18` block:

```rust
    if current < 19 {
        // Automatic titles must never overwrite one the user chose.
        ensure_session_column(conn, "title_source", "TEXT NOT NULL DEFAULT 'auto'")?;
        backfill_title_source(conn)?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (19, ?1)",
            params![now_millis()],
        )?;
    }
```

Also add `("title_source", "TEXT NOT NULL DEFAULT 'auto'")` to the repair list at :564-577.

`upsert_session`: add `title_source` to the column list, `?22` to VALUES, `title_source = excluded.title_source` to the UPDATE SET, and the param `if session.title_source.as_deref() == Some("user") { "user" } else { "auto" }`.

`get_session`: select `title_source` and map `title_source: (raw == "user").then(|| "user".to_string())`.

`block_texts`: after `push_text(&mut texts, block.get("text"));` add `push_text(&mut texts, block.get("recap"));`.

- [ ] **Step 4: Run** `cargo test --manifest-path src-tauri/Cargo.toml session_store` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/session_store.rs
git commit -m "Record whether a session title was set by the user"
```

---

### Task 3: Title source in TS, rename, first-turn guard, auto-titles setting

**Files:**
- Modify: `src/features/sessions/model/session.ts` (`Session` type near `title` :394)
- Modify: `src/features/sessions/data/sessionStore.ts` (payload types :73, :95; `persistableMeta` :133; record → Session :952)
- Modify: `src/app/App.tsx` (`onRenameHistorySession` :4063-4079; `launchTitleGeneration` :6167-6212; fork at ~:8009)
- Modify: `src/features/settings/model/settings.ts`, `settings.flags.test.ts`
- Test: `src/features/sessions/data/sessionStore.test.ts`

**Interfaces:**
- Produces: `Session.titleSource?: "user"` (absent = auto); `loadAutoTitles(): boolean`, `saveAutoTitles(v: boolean)`.

- [ ] **Step 1: Failing tests**

In `settings.flags.test.ts` add to the `describe.each` table:

```ts
  [
    "monocode.autoTitles",
    settings.loadAutoTitles,
    settings.saveAutoTitles,
    true,
    undefined,
  ],
```

In `sessionStore.test.ts`, following that file's existing upsert-payload test style, add a test that a session with `titleSource: "user"` produces `titleSource: "user"` in the `session_upsert` payload and that a record with `titleSource: "user"` loads back with `titleSource: "user"`, while an absent value stays `undefined`.

- [ ] **Step 2: Run** `npx vitest run src/features/settings/model/settings.flags.test.ts src/features/sessions/data/sessionStore.test.ts` — FAIL.

- [ ] **Step 3: Implement**

`session.ts` Session type, next to `title`:

```ts
  /** "user" once the user renamed the session; automatic titles never replace it. */
  titleSource?: "user";
```

`sessionStore.ts`: add `titleSource?: "user" | null;` to the upsert payload/record types; in `persistableMeta` add `...(session.titleSource === "user" ? { titleSource: "user" as const } : {}),`; in record → Session add `...(record.titleSource === "user" ? { titleSource: "user" as const } : {}),`.

`settings.ts` (next to Notes):

```ts
const AUTO_TITLES_KEY = "monocode.autoTitles";
export const AUTO_TITLES_DEFAULT = true;

export function loadAutoTitles(): boolean {
  return readFlag(AUTO_TITLES_KEY) ?? AUTO_TITLES_DEFAULT;
}

export function saveAutoTitles(value: boolean) {
  writeFlag(AUTO_TITLES_KEY, value);
}
```

`App.tsx`:
- `onRenameHistorySession`: both `updated` objects get `titleSource: "user" as const`.
- `launchTitleGeneration`: return early when `!loadAutoTitles()`; in the `setSessions` condition require `s.titleSource !== "user"` in addition to the existing check.
- Fork/handoff session creation (~:8009, where `sessionDisplayTitle(source.title)` is used): copy `titleSource: source.titleSource`.

- [ ] **Step 4: Run tests — PASS; `npx tsc --noEmit` clean.**

- [ ] **Step 5: Commit**

```bash
git add src/features/sessions src/features/settings src/app/App.tsx
git commit -m "Keep user-renamed session titles from automatic replacement"
```

---

### Task 4: Recap prompt, parser, and apply

**Files:**
- Create: `src/features/sessions/model/sessionRecap.ts`
- Create: `src/features/sessions/model/sessionRecap.test.ts`
- Modify: `src/features/sessions/model/session.ts` (`Block` type near `durationMs` :286)

**Interfaces:**
- Consumes: `Session.titleSource` (Task 3), `sanitizeThreadTitle`, `formatSessionTitle`.
- Produces:
  - `Block.recap?: string` (user blocks only)
  - `type SessionRecap = { recap: string; title: string | null; titleChanged: boolean }`
  - `buildSessionRecapPrompt(input: { transcript: string; currentTitle: string }): string`
  - `parseSessionRecap(raw: string): SessionRecap | null`
  - `lastTurnUserBlock(blocks: Block[]): Block | undefined`
  - `applySessionRecap(session: Session, userBlockId: string, result: SessionRecap, allowTitle: boolean): Session`

- [ ] **Step 1: Failing tests**

```ts
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
```

- [ ] **Step 2: Run** `npx vitest run src/features/sessions/model/sessionRecap.test.ts` — FAIL.

- [ ] **Step 3: Implement**

`session.ts` `Block`, below `durationMs`:

```ts
  /** Idle recap of where the session stood after this user turn. */
  recap?: string;
```

`sessionRecap.ts`:

```ts
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
```

- [ ] **Step 4: Run tests — PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/features/sessions/model
git commit -m "Add the session recap prompt, parser, and apply rules"
```

---

### Task 5: Persist and render the recap

**Files:**
- Modify: `src/features/sessions/data/sessionStore.ts` (`sanitizeBlock` :491-590)
- Modify: `src/features/sessions/ui/AgentTranscript.tsx` (before `TurnDuration` at :974)
- Test: `src/features/sessions/data/sessionStore.test.ts`

**Interfaces:**
- Consumes: `Block.recap` (Task 4).
- Produces: `TurnRecap({ text }: { text: string })` component in `AgentTranscript.tsx`.

- [ ] **Step 1: Failing test** in `sessionStore.test.ts`, in that file's `sanitizeBlock`/persist style: a user block `{ id: "u1", role: "user", text: "oi", recap: "Tudo pronto." }` keeps `recap` after sanitizing; an assistant block with `recap` loses it.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement**

`sanitizeBlock`, next to `turnMetrics` (:528):

```ts
  if (block.role === "user" && typeof block.recap === "string" && block.recap.trim()) {
    next.recap = block.recap;
  }
```

`AgentTranscript.tsx`, immediately before `{durationMs != null && settled ? (<TurnDuration`:

```tsx
              {settled && userBlock?.recap ? <TurnRecap text={userBlock.recap} /> : null}
```

At the bottom of the file:

```tsx
/** Idle recap line after a settled turn; backticks render as inline code. */
function TurnRecap({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <p className="px-4 pt-1 pb-2 text-[13px] leading-relaxed italic text-content/50" data-turn-recap>
      <span aria-hidden>※ </span>recap:{" "}
      {parts.map((part, index) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
          <code key={index} className="not-italic font-mono text-[12px]">{part.slice(1, -1)}</code>
        ) : (
          part
        ),
      )}
    </p>
  );
}
```

`/btw` and handoff serialize `block.text` only (`serializeBtwBlock`, btw.ts:265), so the recap stays out of prompts; no change there.

- [ ] **Step 4: Run** `npx vitest run src/features/sessions` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/sessions
git commit -m "Persist and show the recap line under a settled turn"
```

---

### Task 6: Idle recap scheduling, generation, and settings

**Files:**
- Create: `src/features/sessions/model/idleRecap.ts`
- Create: `src/features/sessions/model/idleRecap.test.ts`
- Create: `src/app/useIdleRecap.ts`
- Modify: `src/app/App.tsx` (call the hook once next to the autosave effect ~:1790)
- Modify: `src/features/settings/model/settings.ts` (loaders, `SETTINGS_INDEX` :137), `settings.flags.test.ts`, `src/features/settings/ui/SettingsView.tsx` (after the Notes row :833)

**Interfaces:**
- Consumes: Tasks 3–5 exports; `serializeBtwSnapshot(blocks, lastBlockId, cwd)`; `runHarnessTextPrompt`, `canRunHarnessTextPrompt` (`core/registry.ts`); `pickTextHarness` (`core/textHarness.ts`); `getComposerDraft` (`draftCache.ts`); `sessionWorkCwd`, `sessionDisplayTitle` (`session.ts`).
- Produces:
  - `recapTarget(session: Session, settled: ReadonlySet<string>, draft: string | undefined): string | null`
  - `loadIdleRecap()/saveIdleRecap(v)`, `loadIdleRecapSeconds(): number`, `saveIdleRecapSeconds(v: number)`, `IDLE_RECAP_SECONDS_OPTIONS`
  - `useIdleRecap(input: { sessions: Session[]; sessionsRef: { current: Session[] }; setSessions: Dispatch<SetStateAction<Session[]>> })`

- [ ] **Step 1: Failing tests**

`idleRecap.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newSession, type Session } from "./session";
import { recapTarget } from "./idleRecap";

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
```

`settings.flags.test.ts` table row:

```ts
  [
    "monocode.idleRecap",
    settings.loadIdleRecap,
    settings.saveIdleRecap,
    true,
    undefined,
  ],
```

And, below the table:

```ts
it.each([
  [null, 240],
  ["60", 60],
  ["600", 600],
  ["45", 240],
  ["abc", 240],
])("reads idle recap seconds %j as %d", (stored, expected) => {
  if (stored != null) localStorage.setItem("monocode.idleRecapSeconds", stored);
  expect(settings.loadIdleRecapSeconds()).toBe(expected);
});
```

- [ ] **Step 2: Run** `npx vitest run src/features/sessions/model/idleRecap.test.ts src/features/settings/model/settings.flags.test.ts` — FAIL.

- [ ] **Step 3: Implement `idleRecap.ts`**

```ts
import type { Session } from "./session";
import { lastTurnUserBlock } from "./sessionRecap";

/** User block id to recap now, or null when the session should not get one. */
export function recapTarget(
  session: Session,
  settled: ReadonlySet<string>,
  draft: string | undefined,
): string | null {
  if (session.busy || session.orchestrationLeadId) return null;
  if (draft?.trim()) return null;
  const user = lastTurnUserBlock(session.blocks);
  if (!user || user.recap || user.durationMs == null || !settled.has(user.id)) return null;
  const index = session.blocks.indexOf(user);
  const failed = session.blocks
    .slice(index + 1)
    .some((block) => block.role === "system" && (block.notice === "interrupt" || block.notice === "error"));
  return failed ? null : user.id;
}
```

If `Session` has no `orchestrationLeadId`, use the field the worker check in App.tsx uses (grep `orchestrationLeadId` in `session.ts`).

- [ ] **Step 4: Settings**

`settings.ts`:

```ts
const IDLE_RECAP_KEY = "monocode.idleRecap";
const IDLE_RECAP_SECONDS_KEY = "monocode.idleRecapSeconds";
export const IDLE_RECAP_DEFAULT = true;
export const IDLE_RECAP_SECONDS_DEFAULT = 240;
export const IDLE_RECAP_SECONDS_OPTIONS = [60, 120, 240, 300, 600] as const;

export function loadIdleRecap(): boolean {
  return readFlag(IDLE_RECAP_KEY) ?? IDLE_RECAP_DEFAULT;
}

export function saveIdleRecap(value: boolean) {
  writeFlag(IDLE_RECAP_KEY, value);
}

export function loadIdleRecapSeconds(): number {
  try {
    const value = Number(localStorage.getItem(IDLE_RECAP_SECONDS_KEY));
    return (IDLE_RECAP_SECONDS_OPTIONS as readonly number[]).includes(value)
      ? value
      : IDLE_RECAP_SECONDS_DEFAULT;
  } catch {
    return IDLE_RECAP_SECONDS_DEFAULT;
  }
}

export function saveIdleRecapSeconds(value: number) {
  try {
    localStorage.setItem(IDLE_RECAP_SECONDS_KEY, String(value));
  } catch {
    // private mode / quota
  }
}
```

`SETTINGS_INDEX` entries after `notes`:

```ts
  {
    id: "auto-titles",
    section: "general",
    label: "Automatic session titles",
    keywords: "title rename name session llm",
  },
  {
    id: "idle-recap",
    section: "general",
    label: "Idle recap",
    keywords: "recap summary idle away next step",
  },
```

`SettingsView.tsx`: import the loaders; add state and handlers next to `notesEnabled`:

```tsx
  const [autoTitles, setAutoTitles] = useState(loadAutoTitles);
  const [idleRecap, setIdleRecap] = useState(loadIdleRecap);
  const [idleRecapSeconds, setIdleRecapSeconds] = useState(loadIdleRecapSeconds);
  const onAutoTitles = (next: boolean) => { saveAutoTitles(next); setAutoTitles(next); };
  const onIdleRecap = (next: boolean) => { saveIdleRecap(next); setIdleRecap(next); };
  const onIdleRecapSeconds = (next: string) => {
    const value = Number(next);
    saveIdleRecapSeconds(value);
    setIdleRecapSeconds(value);
  };
```

Rows after the Notes row:

```tsx
        <Row
          id="auto-titles"
          label="Automatic session titles"
          description="Name each session from its first message, and update the name when an idle recap finds the subject changed. Sessions you rename keep their name."
        >
          <Toggle label="Automatic session titles" on={autoTitles} onChange={onAutoTitles} />
        </Row>
        <Row
          id="idle-recap"
          label="Idle recap"
          description="After a session sits idle, add a short recap under the last turn: what was done, where it stands, and the next step."
        >
          <div className="flex items-center gap-2">
            {idleRecap ? (
              <Select
                label="Idle recap delay"
                value={String(idleRecapSeconds)}
                options={IDLE_RECAP_SECONDS_OPTIONS.map((s) => ({ value: String(s), label: `${s / 60} min` }))}
                onChange={onIdleRecapSeconds}
              />
            ) : null}
            <Toggle label="Idle recap" on={idleRecap} onChange={onIdleRecap} />
          </div>
        </Row>
```

- [ ] **Step 5: Implement `useIdleRecap.ts`**

```ts
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { getComposerDraft } from "../features/sessions/model/draftCache";
import { recapTarget } from "../features/sessions/model/idleRecap";
import { serializeBtwSnapshot } from "../features/sessions/model/btw";
import {
  sessionDisplayTitle,
  sessionWorkCwd,
  type Session,
} from "../features/sessions/model/session";
import {
  applySessionRecap,
  buildSessionRecapPrompt,
  parseSessionRecap,
} from "../features/sessions/model/sessionRecap";
import { loadAutoTitles, loadIdleRecap, loadIdleRecapSeconds } from "../features/settings/model/settings";
import { canRunHarnessTextPrompt, runHarnessTextPrompt } from "../integrations/harness/core/registry";
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
        const last = session.blocks.findLast((b) => b.role === "user" && !b.draft && !b.internal);
        if (last) settled.current.add(last.id);
      }
      wasBusy.current.set(session.id, !!session.busy);

      const target = enabled
        ? recapTarget(session, settled.current, getComposerDraft(session.id))
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
      timer.handle = window.setTimeout(() => {
        void fire(session.id, target, timer);
      }, loadIdleRecapSeconds() * 1000);
      timers.current.set(session.id, timer);
    }
    for (const [id, timer] of timers.current) {
      if (live.has(id)) continue;
      window.clearTimeout(timer.handle);
      timer.abort?.abort();
      timers.current.delete(id);
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

  async function fire(sessionId: string, userBlockId: string, timer: Timer) {
    const stillTarget = () => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      return session &&
        loadIdleRecap() &&
        recapTarget(session, settled.current, getComposerDraft(sessionId)) === userBlockId
        ? session
        : null;
    };
    const session = stillTarget();
    if (!session) return;
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
        providerAccountId: harness === session.harness ? session.providerAccountId : undefined,
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
      if (!stillTarget()) return;
      const allowTitle = loadAutoTitles();
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? applySessionRecap(s, userBlockId, result, allowTitle) : s)),
      );
    } catch (error) {
      if (!timer.abort.signal.aborted) console.warn("[monocode] idle recap failed", harness, error);
    }
  }
}
```

Check `Session.providerAccountId` exists (grep in `session.ts`); if the field has another name, use the one `launchTitleGeneration` passes.

`App.tsx`: `useIdleRecap({ sessions, sessionsRef, setSessions });` next to the autosave effect. The autosave effect already persists non-busy sessions whose block identity changed, so the recap and title save without extra code.

- [ ] **Step 6: Run** `npx vitest run src/features src/app` and `npx tsc --noEmit` — PASS/clean.

- [ ] **Step 7: Commit**

```bash
git add src/features src/app
git commit -m "Add an idle recap that can refresh automatic session titles"
```

---

### Task 7: Verify in the app and document

**Files:**
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Added` and `### Fixed`)

- [ ] **Step 1: Full checks**

Run: `npx vitest run` and `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 2: Manual run** `npm run tauri dev`, with Settings → Idle recap delay at 1 min:
  1. New omp session, send "quero configurar o nginx do subdomínio do café" → tab/sidebar title becomes an LLM title within ~10 s (not the truncated message).
  2. Wait 1 min without typing → `※ recap: …` appears under the last answer, in Portuguese, ending with a next step.
  3. Reload the app → the recap is still there; search for a word from it finds the session.
  4. Rename the session in the sidebar, send another message, wait 1 min → a new recap appears and the name is kept.
  5. Type in the composer during the wait → no recap until the draft is cleared.
  6. Repeat step 1–2 with a Claude session.

- [ ] **Step 3: CHANGELOG**

Under `### Added`:

```md
- Idle recap: after a session sits idle (4 minutes by default, 1–10 in Settings), a short muted `※ recap:` line appears under the last turn with what was done, where things stand, and the next step. The same call can rename the session when its subject has clearly changed. Sessions you rename keep their name.
```

Under `### Fixed`:

```md
- omp and Pi sessions get an LLM title after the first message again. MonoCode picked the alphabetically first cheap model, which on current catalogs is the retired Claude 3 Haiku; it now picks the newest cheap model and retries once with the next one.
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "Document idle recap and the omp title fix"
```
