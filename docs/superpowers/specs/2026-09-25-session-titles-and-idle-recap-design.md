# Smart session titles and idle recap — design

Date: 2026-09-25
Status: approved design, pending spec review

## Goal

With many sessions open, each one must be recognizable by its name in the
sidebar and tabs, and returning to a session must show what was done, where it
stands, and the next step — the way omp's terminal shows `※ recap: …`.

1. Fix the first-turn LLM title for omp/Pi (it fails silently today).
2. Refresh the title later, once the session has more context, without ever
   overwriting a title the user set.
3. Show an idle recap after the last turn of a session that has been idle.

## Background

- First-turn titles already exist: `launchTitleGeneration` (App.tsx) →
  `generateHarnessTitle` → adapter `generateTitle` → provider text child.
- omp/Pi failure, confirmed: `pickTextModel` (`piText.ts:54`) takes the first
  catalog entry matching `/haiku|mini|flash|nano|lite|luna/`, and the catalog is
  sorted by name (`modelsFromRpcData`, `piProtocol.ts:736`). On the user's omp
  that is `anthropic/claude-3-haiku-20240307`, which returns
  `404 not_found_error`. `piTitle.ts` swallows the error with `console.debug`,
  so the placeholder (truncated first line) stays. 11 of 12 omp sessions in
  `monocode.db` kept the placeholder.
- omp's recap is TUI-only (`recap.enabled`, default on; `recap.idleSeconds`,
  default 240). After the terminal is idle with an empty editor it runs an
  ephemeral turn and prints `※ recap: …` dim italic. RPC hosts get nothing.
- There is no record of whether a title was set by the user; a refresh today
  (`refreshTitle`) would overwrite a manual rename.

## Scope

In scope: items 1–3 above, for every harness with a text backend; harnesses
without one (fx, hermes, antigravity) use `pickTextHarness`.

Out of scope: consuming omp's own titles over RPC (`PI_RPC_EMIT_TITLE`),
recaps on demand (slash command), a model picker for titles/recaps, showing the
title in the OS window title.

## 1. omp/Pi text model selection

`pickTextModel(flavor, requested)` in `piText.ts`:

1. An explicit `requested` model with a provider (`a/b`) wins, as today.
2. Otherwise rank catalog models matching the cheap pattern by **newest
   version first**: compare the numeric version parsed from the model id
   (e.g. `claude-haiku-4-5` → `[4,5]`, `claude-3-haiku-20240307` → `[3]`),
   dated snapshots losing ties to the undated alias. Return the ordered list,
   not one model.
3. With no cheap match, fall back to the first catalog model, as today.

`promptOnLive` tries the ranked candidates in order: if a candidate fails
before producing output (process error, provider error frame, empty output),
it retries **once** with the next candidate. Timeouts and aborts do not retry.

`piTitle.ts` (and the new recap call) log failures with `console.warn`
including the model id.

## 2. Title source

### Storage

New column `sessions.title_source TEXT NOT NULL DEFAULT 'auto'`, values
`auto | user`, added through a new migration step in `session_store.rs`
`migrate()` using `ensure_session_column`. The migration backfills `user`
for rows whose title is not a placeholder — i.e. not equal to the harness
label, the harness title, or the truncated first line of the first user block
(`titleFromPrompt` rules: first line, 72 chars, `…`). Backfill runs in Rust,
mirroring those rules.

Carried through `SessionUpsert`, `SessionSummary`, `SessionRecord`, the TS
`Session` type (`titleSource: "auto" | "user"`), `sessionStore.ts` payload and
record mapping.

### Writers

- User rename (`onRenameHistorySession`) sets `titleSource: "user"`.
- Every automatic write (first-turn title, recap refresh, automation
  `refreshTitle`) is skipped when `titleSource === "user"`.
- New sessions start `auto`. Forks copy the source's `titleSource`.

## 3. Idle recap

### Trigger

A per-session idle timer in the app (not per tab focus):

- Armed when a turn settles normally (not interrupted, not `session.error`),
  when the recap setting is on.
- Fires after the configured delay (default 240 s; options 60, 120, 240, 300,
  600).
- On fire, it runs only if the session is still not busy, its composer draft
  is empty, it has at least one completed turn, and the last turn has no recap.
- Cancelled by a new submit, a draft becoming non-empty, closing/archiving the
  session, or disabling the setting. A running recap request is aborted by a
  new submit.
- Not armed for orchestration workers or internal/managed turns.

### Generation

- Input: the transcript serialized with the `/btw` serializer
  (`serializeBtwSnapshot`, bounded), plus the current title and title source.
- Call: `runHarnessTextPrompt` on the session's harness (or `pickTextHarness`
  when it has no text backend), with its default cheap model.
- Prompt asks for JSON only:
  `{"recap": string, "title": string, "titleChanged": boolean}`.
  Recap: 1–3 sentences in the conversation's language — what is being done,
  current state, next step. Title: 3–8 words, same rules as
  `THREAD_TITLE_PROMPT`. `titleChanged` true only when the session's subject
  has clearly moved away from the current title.
- Parser `parseSessionRecap` in a new `sessionRecap.ts` next to
  `sessionTitle.ts`: tolerant of fenced JSON, trims, caps recap at 600 chars,
  reuses `sanitizeThreadTitle`. Invalid output → no recap, `console.warn`.

### Applying the result

- The recap is stored on the turn's user block as `recap: string` (same
  pattern as `durationMs`/`turnMetrics`), targeted by block id so a late
  result never lands on another turn. Dropped if that turn is no longer the
  last turn.
- Title: applied only when `titleChanged`, `titleSource === "auto"`, and the
  new title differs; stored via `formatSessionTitle`.

### Rendering and persistence

- `AgentTranscript` renders `※ recap: <text>` after the last assistant output
  of a settled turn, next to `TurnDuration`: muted, italic, markdown inline
  code allowed.
- `sanitizeBlock` whitelists `recap` on user blocks, so it persists in
  `blocks_json`. Rust `block_texts` also indexes the `recap` field, so
  recaps are searchable.
- The recap is never sent to the agent and is excluded from the `/btw`
  serializer and handoff prompts.

## 4. Settings

In `settings.ts` / `SettingsView.tsx`, following the `readFlag` pattern and
`SETTINGS_INDEX`:

- `monocode.autoTitles` (default on): first-turn titles and recap refresh.
- `monocode.idleRecap` (default on).
- `monocode.idleRecapSeconds` (default 240; select 1/2/4/5/10 min).

Read at call time.

## 5. Testing

- `pickTextModel` ranking: newest cheap model wins over older snapshots;
  explicit model wins; fallback when nothing cheap.
- Candidate retry: first candidate errors → second used; timeout → no retry.
- `parseSessionRecap`: valid, fenced, invalid, over-long.
- Idle scheduler (pure helper): arms/cancels/fires under the conditions in §3.
- Title writers: `user` source blocks first-turn and recap updates.
- Rust: migration adds `title_source` and backfills `user` only for
  non-placeholder titles; upsert round-trips it.
- `settings.flags.test.ts` rows for the new flags.
- Manual, in `npm run tauri dev`: omp session gets an LLM title on the first
  turn; after the idle delay a recap appears and survives reload; a renamed
  session keeps its name through a recap; same check with Claude.
