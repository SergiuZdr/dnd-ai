# AI Dungeon Master

A text-mode Dungeons & Dragons campaign, run by Claude, that lives in your terminal — and never has to end. You play a hero; Claude is the Dungeon Master, narrating the world and deciding what NPCs do. It runs on **your own Claude Code subscription** (no API key, nothing to pay for separately), and the dice, hit points, XP, gold, and inventory are all real code the DM narrates around but can never quietly rewrite. Play a scene, quit whenever, and pick up exactly where you left off — the game remembers everything, forever, through a chronicle system that keeps old chapters summarized so the DM's memory never runs out.

## What it looks like

```
┌ Story ───────────────────────────────────┐ ┌ Theron ──────────────┐
│ You push open the tavern door. Smoke     │ │ Lv3 Human Fighter     │
│ and lantern-light spill across the room. │ │                       │
│                                           │ │ ████████████░░░░      │
│ > I ask the barkeep about rumors.        │ │ HP 24/28  AC 16       │
│                                           │ │ XP 900/2700           │
│ "Rumors?" she says, wiping a mug.        │ │ Gold 42               │
│ "Plenty, if you're buying."              │ │                       │
│                                           │ │ — Inventory —         │
│ 🎲 d20+3 (persuasion) → [14]+3 = 17       │ │ Sword ×1              │
│                                           │ │ Shield ×1             │
│ ┌───────────────────────────────────────┐ │ │ Rations ×5            │
│ │ What do you do?                       │ │ │                       │
│ └───────────────────────────────────────┘ │ │ — Quests —            │
│                                           │ │ ◆ Find the Amulet     │
│                                           │ │                       │
│                                           │ │ 📍 The Rusty Anchor   │
└───────────────────────────────────────────┘ └───────────────────────┘
```

## Requirements

- **Node.js 18 or later**
- **[Claude Code](https://claude.com/claude-code)** installed and logged in — any subscription works. If you haven't already, run `claude` once in a terminal, log in, then come back.

No API key, no `.env` file, no config. The game runs through the same login Claude Code already uses, and play bills against your own plan's usage like any other Claude Code session.

## Install & play

```
git clone <this-repo-url>
cd "D&D AI"
npm install
npm run play
```

The folder name has a space in it, so keep the quotes around `"D&D AI"` when you `cd` into it.

The first screen is a menu: **Continue** your last campaign, start a **New campaign**, **Load** an older one, or **Quit**.

## How it plays

- Type what your character does in plain English — "I search the chest," "I try to talk my way past the guard," "I attack the wolf." There's no special syntax to learn.
- Whenever the outcome is uncertain, the DM rolls dice — for real, in code — and narrates around the result. Hit points, XP and leveling, gold, and inventory are all tracked the same way: the DM describes the fiction, but the numbers are computed by the game engine, not by the model, so it can't quietly fudge a roll or hand your character an item you don't have.
- Progress autosaves after every change, not just at the end of a turn — a mid-scene crash loses at most a line of narration, never your character's state.
- Quit anytime (`/quit`, or just close the terminal). **Continue** from the main menu resumes mid-scene next time.
- The campaign never truly ends. As the conversation grows, the game quietly summarizes older chapters into a running "story so far" and starts a fresh session behind the scenes — so the DM's memory of your world never degrades, no matter how many sessions you've played.

## Slash commands

Type these instead of an action:

| Command | What it does |
|---|---|
| `/sheet` | Show your full character sheet — stats, HP, XP, gold, inventory, quests, location |
| `/journal` | Show the story so far and every chapter summary |
| `/save` | Save your progress right now |
| `/retire` | Retire your hero and raise a new one in this same persistent world |
| `/quit` | Save and exit |
| `/help` | List these commands in-game |

## Death

Death is meant to land — the DM is instructed to make it a real, dramatic scene, not a stat-block formality. When your hero falls, the world doesn't end with them: type `/retire` to build a brand-new hero (name, class, race, stats) and step into the same campaign, the same world, the same history, picking up right where the story left off — just with someone new carrying it forward.

## FAQ

**Does this cost anything beyond my subscription?**
No separate billing — play uses your existing Claude Code plan's usage, the same as any other Claude Code session. A typical turn is a small fraction of a normal conversational exchange, roughly a few cents-equivalent worth of usage.

**It says I'm not logged in.**
Run `claude` once in a terminal to log in (any subscription), then relaunch `npm run play`.

**What does "the weave is exhausted" mean?**
That's the in-fiction version of a rate-limit message — you've hit a temporary usage limit on your plan. Wait a few minutes and try again; your save is untouched.

**Where do saves live? Can I back them up?**
In `saves/<campaign-name>/` at the repo root, as plain JSON files (plus a raw transcript log). Back up a campaign by copying its folder — nothing here is a database or binary format.

**How do I choose PG-13 vs. R content?**
It's a step in the New Campaign wizard, right after you pick a world theme. PG-13 is the default; R allows more mature themes and violence (never sexual content, in either rating).

**Advanced: can I change which Claude model runs a campaign?**
Yes — add `"modelOverride": "opus"` (or `"sonnet"` / `"haiku"`) to that campaign's `saves/<slug>/campaign.json` file. Leave it unset to use your Claude Code default.

**Is there a debug mode?**
`npm run play -- --debug` logs every raw message from the Agent SDK to `saves/<slug>/debug.log`, useful if something looks off and you want to see exactly what the DM's session sent and received.

**How do I run the tests?**
`npm test` runs the full test suite (engine math, saves, the memory system, etc.) — no AI calls, no billing.

## For developers

```
src/
  game/     dice, engine (state mutations + validation), saves, character-creation math
  ai/       Agent SDK session wrapper, DM system prompt + context-brief builder, MCP tool layer, chronicle summarizer
  ui/       ink components: App shell, story log, sidebar, input bar, wizard
```

The engine owns every mechanical rule; the AI layer only narrates and calls tools the engine validates. See `PLAN.md` for the full design writeup.

- `npm test` — the full vitest suite, no AI calls.
- `npm run typecheck` — `tsc --noEmit`.
- Three smoke scripts prove the real Agent SDK integration end-to-end. The first is free; **the other two bill real turns** against whatever account is logged in:
  - `npm run spike` — ~30-line proof that subscription auth + streaming + an in-process MCP tool all work. Cheap (one short turn).
  - `npm run smoke` — headless proof that a full DM turn narrates, calls tools, mutates state, and autosaves. Bills a few real turns.
  - `npm run smoke:memory` — headless proof of the chronicle + session-rotation system end to end. Bills several real turns, including at least one haiku summarizer call.
