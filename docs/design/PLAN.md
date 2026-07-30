# AI Dungeon Master — architecture & design

> Living document. Describes the system **as it is**, and why it's shaped that way.
> Last reconciled with the code: 2026-07-26.
>
> For the requirements history that drove the later phases, see
> `docs/requirements/` (SRD → PRD → review log). For running it in the cloud,
> see `docs/DEPLOY.md`. For playing it, see the root `README.md`.

---

## What this is

A D&D-style text RPG where an LLM is the dungeon master and the story can run
forever. A player types what their character does in plain English; the model
narrates and plays the world. **The model never owns the numbers** — dice, HP,
XP, gold, inventory, quests and NPCs all live in deterministic code that the
model can only touch through validated tools.

Two front ends sit on one game core. The **web client** (`npm run serve`) is the
way to play: phone or desktop browser, BG3-styled HUD. The original **ink
terminal UI** (`npm run play`) still runs and still passes its tests, but it is
legacy — new work lands on web first, and a few features (ledger toasts, the
campaign-delete flow, sign-out) only exist there.

## Locked decisions

Original decisions from the v1 Q&A, annotated with what actually held up:

| Decision | Status |
|---|---|
| **Hybrid engine** — code owns dice/HP/XP/inventory/gold; the AI mutates state only through tools | **Held completely.** The single most load-bearing decision in the project; everything below is arranged to protect it. |
| **TypeScript**, one `npm install`, no build step (`tsx` runs the sources directly) | **Held.** Also what makes the Docker image trivial — it runs the same entry point local dev does. |
| **Terminal TUI** as the interface | **Superseded.** The browser client is the primary UI; the TUI is legacy. The `GameController` seam meant this cost no engine changes — see "Two front ends" below. |
| **Claude Code subscription via the Claude Agent SDK**, no API key anywhere | **Superseded as the default**, retained as a backend. Wanting mature content and zero token spend led to OpenAI-compatible backends; see "Three DM backends". |

## Architecture

```
   ┌──────────────────────┐        ┌──────────────────────────┐
   │  web client          │        │  ink terminal UI         │
   │  src/web/index.html  │        │  src/ui/*  (legacy)      │
   └──────────┬───────────┘        └────────────┬─────────────┘
              │ HTTP + SSE                      │ React state
   ┌──────────▼───────────┐                     │
   │  server.ts (routes,  │                     │
   │  auth, sessions)     │                     │
   │  bridge.ts (callbacks│                     │
   │  -> SSE events)      │                     │
   └──────────┬───────────┘                     │
              └───────────┬─────────────────────┘
                          │  ControllerCallbacks
              ┌───────────▼────────────────────────────┐
              │  GameController (src/game/controller)  │
              │   • the turn loop                      │
              │   • chronicle summarize + session swap │
              │   • interactive player-roll arbitration│
              │   • debounced autosave                 │
              ├──────────────────┬─────────────────────┤
              │  Engine          │  DmSession (one of  │
              │  dice, HP, XP,   │  three backends)    │
              │  gold, items,    │   system prompt     │
              │  quests, NPCs    │   11 tools          │
              └──────────────────┴─────────────────────┘
                     saves/[players/<id>/]<slug>/ (JSON, autosaved)
```

**The trust boundary is the tool layer.** `src/ai/tools.ts` exposes exactly
eleven moves, each a thin wrapper over one `Engine` method. The engine validates
and either applies or returns `{ ok: false, error }`, which the tool turns into
an `ERROR: …` result the model sees and narrates around. Nothing else can change
state. Dice are real RNG in code, so a roll cannot be fudged. On the Claude
backend this is enforced structurally too: `settingSources: []` (so no
user/project settings or CLAUDE.md leak in), `tools: []` (no Bash/Read/Write),
`allowedTools` listing only the game's own MCP tool names, and a custom
`systemPrompt` rather than the `claude_code` preset.

### Two front ends, one core

`GameController` is UI-free: it reports everything through a `ControllerCallbacks`
object (`onStoryAppend`, `onStreamText`, `onStateChange`, `onDiceRoll`,
`onRollPrompt`, `onLedgerGain`, `onBusyChange`, `onSystemNote`,
`onHistoryReplay`). `App.tsx` maps those to React state; `GameBridge` maps the
same ones to SSE events. Neither knows anything about the other, and the
controller knows about neither. Adding the entire web client required no engine
or controller changes — that's the payoff, and it's worth preserving.

The web server takes no framework and no new dependencies: Node's `http` plus
Server-Sent Events. SSE (not WebSockets) because the game is turn-based and
`EventSource` gives reconnect-on-drop for free, which is exactly what a phone
needs across screen locks and network blips.

### Three DM backends

All three implement the same `DmSessionLike` surface (`start`/`send`/`interrupt`/
`end`/`busy`) and fire the same `DmSessionCallbacks`. `dmBackend` in
`settings.json` (or `DND_DM_BACKEND`) picks one; `defaultSessionFactory` in
`controller.ts` is the only place that branches.

| Backend | File | What it does |
|---|---|---|
| `claude` | `ai/dm.ts` | One Agent SDK `query()` in streaming-input mode, tools via an in-process MCP server. Needs a Claude Code login, so it cannot run in a headless container. |
| `openai` | `ai/openaiDm.ts` | One model on any OpenAI-compatible `/v1/chat/completions` with tool-calling. Hand-rolled agentic loop: stream, accumulate `tool_calls`, execute, push `role:"tool"` results, repeat until a step calls nothing. |
| `dual` | `ai/dualDm.ts` | Two models, one endpoint. A **referee** runs the tool loop and emits a terse internal beat sheet; a **narrator** with no tools turns that into the prose the player reads. |

`dual` exists to resolve a real tension: the models that reliably call tools with
well-formed arguments are the ones most likely to refuse mature content, and the
permissive ones mangle tool arguments. Splitting the roles lets each model do
what it's good at. The narrator never touches state, so it cannot break the
mechanics no matter what it writes — but it also can't *see* state, which is why
it's handed a ground-truth hero sheet (`formatHeroGroundTruth`) and an explicit
"the referee resolved nothing this turn" note. Without those it would happily
narrate a heal that never happened.

Supporting pieces shared by the two OpenAI-compatible backends:

- `ai/toolSchema.ts` derives the OpenAI function schemas from the *same* zod
  shapes the tools are built from (`z.toJSONSchema`), so the two definitions
  cannot drift.
- `ai/argRepair.ts` repairs the malformations open models actually produce —
  JSON-Schema-shaped wrappers (`{"type":"integer","value":15}` → `15`), numeric
  strings, unknown keys — then validates against the tool's zod schema.
  Unrepairable args become an `ERROR:` result, never a throw.
- `ai/openaiStream.ts` is the pure SSE decode + step accumulation (network-free,
  so it's testable against canned streams).
- `ai/openaiHttp.ts` holds the one retry-on-5xx policy and the HTTP/network →
  friendly-error mapping, shared so error copy can't drift between backends.

### The "forever" memory system

The campaign is designed never to end, which means context can never be allowed
to grow without bound.

1. `transcript.jsonl` is the full append-only log. It is never sent whole.
2. When the un-summarized tail crosses a threshold (24 000 chars **or** 40
   entries), `runChronicleUpdate()` fires: a one-shot summarizer call condenses
   it into a chapter summary plus an updated "story so far" rollup, both
   persisted in `chronicle.json`.
3. The DM session is then quietly ended and a fresh one constructed — so
   context resets rather than degrades, no matter how many sessions have been
   played.
4. The fresh session is **not** given its context brief immediately. Re-narrating
   a scene the player is already in is jarring and bills a wasted turn, so the
   brief is held as `pendingBrief` and rides along with the player's next action.

The summarizer (`ai/summarizer.ts`) follows `dmBackend` for the same reason play
does: on `openai` and `dual` it posts to the configured endpoint, so a
zero-Claude-token deploy stays zero-token for rollups too.

**Structured state is the real memory.** Character, world, NPCs, quests and facts
are ground truth in JSON, updated through tools — so they survive intact even
after the prose describing how they got that way has been summarized away.

On resume the controller replays the un-summarized transcript tail into the story
log verbatim and takes **no** DM turn. The player sees their own actual prior
scene rather than a model's reconstruction of it. The one exception: if the last
line is a *player* line, the DM never got to answer, so the brief is sent
immediately rather than dropping that action on the floor.

### Interactive player rolls

When the hero is the one rolling, `roll_dice(roller:'player')` does not roll
immediately — the tool handler awaits `hooks.interactiveRoll`, which parks the
promise until the UI reports that the player pressed the button. Because every
backend `await`s its tool handlers, the whole turn simply pauses, with no
backend-specific handling anywhere. A failed roll with luck remaining parks a
second time for the reroll decision.

### Multiplayer & isolation

`src/game/players.ts` holds a small registry: one 96-bit access code per player,
stored only as a SHA-256 digest (generated, never human-chosen — which is
precisely why a plain digest is right here and scrypt/argon2 would only add
latency against an unreachable attack).

Isolation needed no changes to `saves.ts`: every function there already took a
`baseDir`, so the server hands each request `playerSavesDir(root, playerId)` and
per-player separation falls out of the existing seam. `savePaths()` is the one
place that resolves a slug to a directory, and it **throws** rather than
sanitizes if the result escapes its save root — a slug that needed rewriting was
not a slug this server issued, and quietly redirecting it to a neighbouring
player's directory would be worse than refusing.

The server picks its auth mode per request from `hasPlayers()`: empty registry →
shared `GAME_PIN`; anyone registered → access codes, and the PIN is ignored.
SSE authenticates with single-use short-lived tickets, so no long-lived
credential ever appears in a URL (where it would land in proxy logs, browser
history and `Referer` headers).

### Durability

Every save file is a `{ schemaVersion, data }` envelope written atomically
(temp + rename). Autosave is dirty-marked on **every** applied tool call and
debounced, then forced at turn end — a mid-turn crash costs at most a line of
narration, never state. A newer `schemaVersion` than the build understands is a
hard error; older runs through a migration hook (currently v1→v2 luck/background,
v2→v3 quest rewards). Campaign deletion moves the folder to `.deleted/` rather
than unlinking it, because a campaign can represent weeks of play and there is no
undo in the UI.

## Project layout

```
src/
  index.tsx           TUI entry (--render-check paints once and exits, unbilled)
  game/
    controller.ts     the turn loop, chronicle rotation, roll arbitration
    engine.ts         every state mutation + validation; never throws outward
    dice.ts           expression parse + roll, advantage/disadvantage
    state.ts          types, XP table, ability-mod helpers, SCHEMA_VERSION
    saves.ts          save/load/list/delete, atomic writes, migrations, slug containment
    newCampaign.ts    class/race/background/theme catalogs + creation math
    settings.ts       settings.json + DND_* env overrides (env > file > default)
    players.ts        access-code registry + per-player save namespacing
  ai/
    dm.ts             Claude Agent SDK backend (+ DmError, the shared config types)
    openaiDm.ts       single-model OpenAI-compatible backend
    dualDm.ts         referee + narrator split backend
    openaiStream.ts   pure SSE decode + step accumulation
    openaiHttp.ts     shared retry policy + error classification
    toolSchema.ts     zod shapes -> OpenAI function schemas
    argRepair.ts      repair-then-validate malformed tool arguments
    tools.ts          the 11 tools; the entire trust boundary
    prompts.ts        3 system prompts, context brief, mechanics reminder
    summarizer.ts     chronicle rollup (routes by dmBackend)
  ui/                 ink components: App shell, bounded story log, sidebar,
                      input bar, dice card, wizard, pure layout/wrap helpers
  web/
    server.ts         HTTP/SSE routes, auth, per-player sessions
    bridge.ts         ControllerCallbacks -> SSE events (pure, no I/O)
    serve.ts          CLI entry + env resolution + startup box
    index.html        the entire client, one file, no build step

test/                 mirrors src/ one-for-one: test/game, test/ai, test/ui,
                      test/web, plus test/scripts for the admin scripts.
                      `npm test` runs all of it and makes no AI calls.

scripts/
  smoke/              live proofs against a REAL endpoint. These BILL.
  admin/              maintenance on saves; dry-run by default, back up first
  tunnel.ts           serve + a Cloudflare quick tunnel

docs/
  DEPLOY.md           cloud runbook (Fly + Oracle Always-Free)
  design/PLAN.md      this file
  requirements/       SRD, PRD, review log — the "why", as written at the time
```

`scripts/` is split by **consequence**, not topic: everything under `smoke/`
costs money to run and everything under `admin/` mutates saves, so the directory
name is the warning.

`index.html` is deliberately one 2 700-line file. Splitting it would require a
bundler, and "no build step" is what keeps `npm install && npm run serve` the
whole setup story — including inside Docker, which runs that same entry point.

## Verification

- `npm test` — the full vitest suite. No AI calls, no billing, no network.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run spike` — proves subscription auth + streaming + in-process MCP still
  work. One cheap turn.
- `npm run smoke` / `smoke:openai` / `smoke:dual` — **these bill.** Headless
  end-to-end proof that a real DM turn narrates, calls tools, mutates state and
  autosaves, scored against a ≥3/4 tool-calling bar.
- `npm run smoke:memory` — the chronicle + session-rotation system end to end.

**Nothing in `npm test` can tell you whether narration got worse.** Any change to
`ai/prompts.ts` needs a live smoke before it's trusted.

## Deliberately out of scope

Full 5e combat (initiative, spell slots), simultaneous multiplayer in one
campaign, image generation, npm publishing, Windows terminal QA. Per-player
*billing* is also out: the owner supplies one endpoint key for everyone.
