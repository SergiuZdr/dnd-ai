# AI Dungeon Master — Terminal TUI RPG (endless campaign)

## Context

Sergiu wants a D&D-style text RPG where Claude is the dungeon master, with a story that can go on forever. The project must be shareable: a friend with **only a Claude Code subscription** (no API key) clones the repo and plays — each player's game runs on their own Claude login. Directory `/Users/Sergiu/DevG/D&D AI` is empty; this is a greenfield build.

**Locked decisions (from Q&A):**
- Interface: **Terminal TUI** — full-screen app, fixed panels (story log, character sheet, quests, input)
- AI access: **Claude Code subscription via the Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — the SDK bundles the Claude Code runtime and reuses the player's existing login; no API key anywhere
- Mechanics: **Hybrid engine** — code owns dice/HP/XP/inventory/gold; the AI narrates and mutates state only through tools
- Language: **TypeScript** (follows from the sharing requirement — one `npm install`, no separate CLI/Python setup)

## Tech stack

| Piece | Choice | Why |
|---|---|---|
| AI | `@anthropic-ai/claude-agent-sdk` | Runs on the player's Claude Code login; streaming; custom tools via in-process MCP server. Claude Code's own UI is built on ink, so this stack is proven for terminal chat UIs |
| TUI | `ink` + `react` + `ink-text-input` | Flexbox panel layout, borders, live re-render; input handling |
| Tool schemas | `zod` | Agent SDK's `tool()` helper takes zod schemas |
| Runner | `tsx` | No build step — `npm run play` just works for friends |
| Tests | `vitest` | Engine unit tests (dice, leveling, saves) |

Node ≥ 18 required. Verify exact SDK API names against the installed package's TypeScript types at implementation time (key surface: `query({prompt, options})`, `createSdkMcpServer`, `tool()`, `options.mcpServers/allowedTools/systemPrompt/model/includePartialMessages`).

## Architecture

```
┌─ TUI (ink) ────────────────────────────────┐
│ story log │ char sheet │ quests │ input    │
└─────┬──────────────────────────▲───────────┘
      │ player input             │ narration stream + state snapshots
┌─────▼──────────────────────────┴───────────┐
│ Game controller (turn loop)                │
│  • assembles context brief per session     │
│  • runs summarizer / session rotation      │
├────────────┬───────────────────────────────┤
│ Engine     │ AI layer (Agent SDK session)  │
│ dice, HP,  │  system prompt = DM persona   │
│ XP/levels, │  tools (in-process MCP):      │
│ inventory, │   roll_dice, apply_damage,    │
│ quests,    │   heal, award_xp, gold,       │
│ NPCs, saves│   add/remove_item, quests,    │
│            │   npcs, location, facts       │
└────────────┴───────────────────────────────┘
        saves/<campaign>/ (JSON, autosave)
```

**Trust boundary:** the model never edits state directly — every mechanical change goes through a tool the engine validates and applies (dice are real RNG in code, so the DM can't fudge). Built-in Claude Code tools (Bash/Read/Write/etc.) are disabled; only the game's MCP tools are allowed. Don't load user/project settings or CLAUDE.md into the game session.

## Project layout

```
package.json            bin/scripts: "play" → tsx src/index.tsx
src/
  index.tsx             boot: auth check → main menu (Continue / New / Load / Quit)
  ui/                   ink components
    App.tsx             layout shell, resize handling, min-size warning
    StoryLog.tsx        scrolling narration (typewriter via stream deltas)
    Sidebar.tsx         HP bar, stats, XP, gold, inventory, quests, location
    DiceLine.tsx        latest roll flourish (🎲 d20+2 → 17 ✓)
    InputBar.tsx        text input + slash commands
    wizard/             character creation + campaign setup screens
  game/
    controller.ts       turn loop, session lifecycle, autosave hooks
    engine.ts           state mutations, validation, level-up math (5e-ish XP table)
    dice.ts             parser+roller: "d20", "2d6+3", advantage/disadvantage
    state.ts            types: Character, World, Npc, Quest, Chronicle
    saves.ts            saves/<slug>/{campaign,character,world,chronicle}.json + transcript.jsonl
  ai/
    dm.ts               Agent SDK session wrapper (streaming turns, error handling)
    tools.ts            createSdkMcpServer + tool definitions (zod)
    prompts.ts          DM system prompt, context-brief builder, summarizer prompt
  test/                 vitest: dice.test.ts, engine.test.ts, saves.test.ts
README.md               friend-facing: requirements, install, play, FAQ
```

## Key designs

### 1. AI session (Agent SDK)
- One streaming `query()` session per play sitting: system prompt = DM persona + tool contract + content rating (PG-13 default, configurable).
- First user message each sitting = **context brief**: story-so-far rollup + last 2–3 chapter summaries + current state JSON + last ~15 transcript exchanges verbatim + "resume the scene".
- `includePartialMessages` for token-by-token narration in the TUI.
- Model: use the player's Claude Code default (works on any plan); optional override in config (`opus`/`sonnet`/`haiku`).
- Friendly failures: not logged in → "Run `claude` once to log in, then come back"; rate limit → in-fiction message ("the weave is exhausted — rest a moment").

### 2. The "forever" memory system
- `transcript.jsonl` — full raw log, append-only (never sent whole).
- **Chronicle**: every ~40 exchanges, a one-shot summarizer call (no tools) condenses the oldest chunk into a chapter summary + updates a "story so far" rollup; both persisted in `chronicle.json`.
- **Session rotation**: after summarizing, quietly start a fresh SDK session with a new context brief (between turns; show "✦ chronicle updated"). Context therefore never degrades no matter how long the campaign runs.
- **Structured state** (character/world/NPCs/quests) is the ground truth, updated via tools — facts survive even when prose is summarized away.

### 3. Hybrid mechanics (tools the DM must call)
`roll_dice(expr, reason)` · `apply_damage/heal(amount, reason)` · `award_xp(amount)` (engine handles level-ups, returns "leveled up!" so DM narrates) · `modify_gold` · `add_item/remove_item` · `upsert_quest(title, status, note)` · `upsert_npc(name, disposition, fact, status)` · `set_location(name)` · `record_fact(fact)`. Each returns a result the DM weaves into narration; each application updates the sidebar live and marks the save dirty.

### 4. Gameplay flow
- **Main menu** → Continue latest / New campaign / Load / Quit.
- **New campaign wizard** (pure code, no AI): name, class (4–6 presets), race, stats (4d6-drop-lowest or standard array), world theme (classic / grim / whimsical / custom seed).
- **Turn loop**: player types action → DM streams narration + tool calls → engine applies → autosave → "What do you do?".
- **Slash commands**: `/sheet` `/journal` (chronicle) `/save` `/load` `/help` `/quit`.
- **Death**: DM instructed to use dramatic consequences/death saves; on true death, offer a new character in the same persistent world (the world outlives heroes — fits "forever").

### 5. Distribution (the sharing requirement)
README instructions for friends: have Claude Code installed + logged in (any subscription) → `git clone` → `npm install` → `npm run play`. No API key, no config. Their play bills against their own plan usage. Optional later: publish as `npx dnd-ai`.

## Implementation order

1. **Scaffold + engine**: package.json, tsconfig, dice parser, state types, engine mutations, level math, saves — with vitest tests.
2. **AI layer**: tools.ts, prompts.ts, dm.ts; prove a headless scripted conversation works end-to-end on the real SDK (2–3 turns, tool calls land).
3. **TUI**: App layout, sidebar bound to engine state, story log with streaming, input, wizard, main menu.
4. **Memory**: transcript, summarizer, chronicle, session rotation, resume-from-save.
5. **Polish**: slash commands, dice flourish, error UX, README, a `--debug` flag that logs raw SDK messages to a file.

## Verification

- `npm test` — dice distribution/parsing, XP/level thresholds, save/load round-trip.
- Headless smoke script (step 2) — asserts: narration text received, `roll_dice` + at least one state tool called, state mutated, autosave file written.
- Real play-through (/verify style): launch TUI, create a character, play ~4 turns; confirm sidebar updates from tool calls, kill the app, relaunch → Continue restores scene coherently; force a low summarization threshold once to watch chronicle + session rotation fire.
- Fresh-machine check for the sharing story: clone into a temp dir, `npm install`, `npm run play` with no repo-local state.

## Out of scope (v1) — noted for later
Initiative/spell-slot combat (full 5e), multiplayer/shared campaigns, image generation for scenes, npm publishing, Windows terminal QA (ink works, but untested here).
