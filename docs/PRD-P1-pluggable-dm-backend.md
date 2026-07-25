# PRD — P1: Pluggable OpenAI-compatible DM backend (get off Claude tokens)

> Version: V0.1
> Date: 2026-07-24
> Author: Sergiu
> Related: `docs/SRD-cloud-open-model-hud.md` (this is SRD Phase P1)

---

## 1. Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| V0.1 | 2026-07-24 | Sergiu | Initial draft |

## 2. Background

The DM currently runs on the Claude Agent SDK (`src/ai/dm.ts` → `query()`), so every turn spends the owner's Claude subscription and is capped at Claude's content ceiling. Goal of P1: make the DM talk to **any OpenAI-compatible chat-completions endpoint with tool-calling** (Ollama / OpenRouter / self-host), selectable by config, so gameplay costs **0 Claude tokens** and can use an uncensored model — **without** rewriting the game engine, controller, bridge, or UI.

**Spike finding baked into this spec (2026-07-24):** open models *do* return real `tool_calls` for the game's prompt, but small models mangle arguments (observed: `dc` returned as `{"type":"integer","value":15}`, `expr` as `"Strength check"`). Therefore P1 MUST include an **argument validate-and-repair layer**, and the recommended default is a *capably-sized* model (a 3B is too weak). Model choice stays a config value.

## 3. Overview

| Item | Content |
|---|---|
| Platform | Web (existing Node server); terminal path unaffected |
| Core feature | A second `DmSession` implementation that drives an OpenAI-compatible endpoint, chosen via settings; Claude path retained |
| Touch points | `src/ai/*` (new backend + tool-schema + settings), `src/game/controller.ts` (session factory selection only), tests |
| Explicitly unchanged | `Engine`, `GameController` callback surface, `GameBridge`, `src/web/*`, `src/ui/*`, save format |

## 4. Product requirements

### 4.1 Behavior

- **PR-1 — New backend, same shape.** Add `OpenAiDmSession` (name TBD) implementing the exact `DmSessionLike` surface the controller already uses (`start()`, `send()`, `interrupt()`, `end()`, `busy`) and firing the same `DmSessionCallbacks` (`onDelta`, `onToolUse`, `onTurnComplete({text, costUsd})`, `onSystemNote`, `onError`, `onRawMessage`). The controller/bridge/UI must need **no changes beyond backend selection**.
- **PR-2 — Agentic tool loop.** On `send(playerText)`: append the user message; POST `/v1/chat/completions` with `{model, messages, tools, tool_choice:"auto", stream:true}`; stream assistant text via `onDelta`; accumulate `tool_calls`; when a step finishes with tool calls, **execute each via the existing tool handlers** (`createDmTools().tools`, which already wrap the engine + `interactiveRoll` + `onLedger`), push each result as a `role:"tool"` message, and loop; when a step finishes with no tool calls, fire `onTurnComplete({text})`. Cap internal steps (reuse `maxTurnsPerMessage`, default 12).
- **PR-3 — Streaming.** Parse the OpenAI SSE stream: `choices[0].delta.content` → `onDelta`; `choices[0].delta.tool_calls[]` → accumulate by index; `finish_reason:"tool_calls"` → execute; `"stop"` → complete. `costUsd` is unknown for these endpoints → omit/undefined (fine).
- **PR-4 — Interactive player roll preserved.** `roll_dice` with `roller:"player"` already routes through `hooks.interactiveRoll` (an awaited promise the UI resolves). Because the loop `await`s each tool handler, the turn naturally pauses for the physical roll exactly as today — no special-casing needed; just don't race it.
- **PR-5 — Summarizer.** `src/ai/summarizer.ts` (chronicle roll-up, currently a cheap Claude call) gets an OpenAI-compatible path so chronicle updates also spend 0 Claude tokens when the OpenAI backend is active.

### 4.2 Data / business logic

- **PR-6 — Tool schema conversion.** Convert the 11 engine tools' **zod input schemas** (already on `createDmTools().tools`) into OpenAI `function` schemas (`{type:"function", function:{name, description, parameters:<json-schema>}}`). Prefer deriving JSON Schema from the existing zod (e.g. `zod`'s `.toJSONSchema`/a converter) so the two never drift; hand-mapping is acceptable only if kept in one place with a test that all 11 names/required-fields match `tools`.
- **PR-7 — Argument validate-and-repair (the spike's #1 requirement).** Before invoking a handler, parse the model's `arguments` JSON and repair common malformations, then validate against the tool's zod schema:
  - unwrap JSON-Schema-shaped values, e.g. `{"type":"integer","value":15}` → `15`;
  - coerce numeric strings → numbers where the schema wants a number;
  - drop unknown keys.
  On still-invalid args, **do not crash** — return a `role:"tool"` result of `ERROR: <what's wrong>` so the model self-corrects on the next step (mirrors today's engine-ERROR feedback). Add a per-turn guardrail: if a consequential turn produced zero tool calls, the existing `withMechanicsReminder` nudge already covers it; do not add new prompt scaffolding here.
- **PR-8 — Errors.** Map HTTP/network failures to `DmError` with a friendly message (auth/rate-limit/unknown), same as `classifyThrownError`.

### 4.4 Backend / configuration

**Business layer:**
- The owner configures the endpoint without editing code: **base URL, model, and an API-key *env var name*** (never the key value in a committed file). Selection of backend (`claude` vs `openai`) is a setting; per-campaign `modelOverride` still works.
- Zero-config dev default: point at local Ollama (`http://127.0.0.1:11434/v1`, no key) so `npm run` works out of the box for a developer with Ollama.

> ⚠️ Technical layer (dev):
> - Extend `src/game/settings.ts`: `dmBackend?: "claude" | "openai"` (default `"claude"` so nothing changes until opted in); `openai?: { baseUrl: string; model: string; apiKeyEnv?: string }`. Read the key from `process.env[apiKeyEnv]` at session start; if missing and the endpoint needs one, surface a friendly `onSystemNote`/`DmError`.
> - `GameController.start()` selects the backend via the existing `sessionFactory` seam (default factory reads settings and constructs the right class). Keep the `DmSessionLike`/`sessionFactory` test seam intact.
> - New file(s) under `src/ai/` (e.g. `openaiDm.ts`, `toolSchema.ts`). Do not touch `src/web/*` or `src/ui/*`.
> - Secrets: `.env` support via reading `process.env` only; never write keys to `saves/` or commit them; add `.env` to `.gitignore` if used.

### Acceptance criteria (unit-testable + one live check)

- [ ] With `dmBackend:"claude"` (default) everything behaves exactly as today; `npm run typecheck` + `npm test` stay green.
- [ ] `toolSchema` emits exactly 11 OpenAI function schemas whose names + required fields match `createDmTools().tools` (test).
- [ ] Arg-repair turns `{dc:{type:"integer",value:15}, expr:"d20+3", reason:"x", roller:"player"}` into a valid `roll_dice` call; turns a numeric-string `amount:"25"` into `25` for `award_xp` (test).
- [ ] Invalid args that can't be repaired produce an `ERROR: …` tool result (fed back to the model), never a throw (test).
- [ ] The SSE parser assembles interleaved `content` deltas and multi-index `tool_calls` from a canned OpenAI-style stream into the right `onDelta` calls + one executed tool call (test with a mocked stream — no network).
- [ ] A documented live smoke (`npm run smoke:openai` or a scripted step) runs the opening + a force-door + a loot turn against a configured endpoint and reports a tool-calling score ≥ 3/4 (run by the owner against their chosen endpoint; not part of CI).

## 6. Non-functional requirements

### 6.2 Fault tolerance
- Malformed tool args → repair, else ERROR-feedback self-correction (PR-7). Endpoint 5xx/network → one retry with backoff, then a friendly `DmError`. Stream truncation → treat accumulated text as the turn if a `stop`/close arrives; otherwise error.

### 6.5 Security
- API key only from `process.env[apiKeyEnv]`; never logged (`--debug` must redact it), never committed, never written to saves. PIN + IP rate-limit already protect the web surface.

## 7. Rollout

| Item | Content |
|---|---|
| Method | Additive + config-flagged. `dmBackend` defaults to `"claude"`; the OpenAI path ships dormant until the owner opts in. |
| Dependencies | For a real run: a reachable OpenAI-compatible endpoint (local Ollama for dev; a capable free-tier cloud model for production — owner supplies base URL + key). |
| Rollback | Set `dmBackend:"claude"` — instant revert, no data change. |
| Follow-on phases | P2 cloud-host game+saves (drop tunnel); P3 BG3 HUD. Both out of scope here. |

### Note on "free"
A 3B local model is too weak (spike). For production, target a **capable free-tier cloud model** (e.g. a 70B-class model on a free OpenRouter/Ollama-Cloud tier) — same code, just config. The owner must pick the provider + supply a key; the arg-repair layer keeps even mid-tier models usable.
