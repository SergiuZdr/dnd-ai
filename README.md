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
│ "Plenty, if you're buying."              │ │ ✦ Luck 2              │
│                                           │ │                       │
│ 🎲 d20+3 (Persuasion) → [14]+3 = 17       │ │ — Inventory —         │
│ vs DC 13 — ✓ success                     │ │ Sword ×1              │
│ ┌───────────────────────────────────────┐ │ │ Shield ×1             │
│ │ What do you do?                       │ │ │ Rations ×5            │
│ └───────────────────────────────────────┘ │ │                       │
│                                           │ │ — Quests —            │
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

## Rolling the dice

Whenever *your hero* attacks, makes a skill check, or saves against something, the game pauses and hands the die to you:

1. A prompt appears where the dice line usually sits: `🎲 Persuasion — DC 13 — press SPACE to roll` (the DC is the number you need to meet or beat; it's omitted for rolls with no real stakes).
2. Press **SPACE** or **Enter** — the die face cycles for a moment, then the real result (rolled in code, never by the model) is revealed: `🎲 d20+3 (Persuasion) → [14]+3 = 17 vs DC 13 — ✓ success`.
3. If the roll **fails** its DC and you still have luck left, you're offered a reroll: `✦ Luck 2 — press L to reroll, Enter to accept`. Spending luck rerolls the same roll and keeps whichever total is better — win or lose, that luck point is gone either way. Every hero starts with 1 luck and gains another on each level-up, capped at 3.
4. The DM narrates around whatever actually happened — including a bit of "fate intervened" flavor when a luck reroll saved the day.

NPCs, monsters, and the world roll their own dice too (behind the scenes, instantly) — only the hero's own rolls pause for a button press.

While the game is idle or the DM is narrating, the input bar shows what's happening; Esc interrupts a rambling DM turn, but does nothing while a roll is waiting on you (so it can never cancel a roll by mistake).

## Character creation

The New Campaign wizard walks through: campaign name, hero name, **class**, **race**, **background**, ability scores, world theme, and content rating. Highlight any option to see a one-line tooltip with the mechanical details.

- **Classes** (Fighter, Rogue, Wizard, Cleric, Ranger, Bard) each list their playstyle, hit die, key stat, and starting kit.
- **Races** grant real stat bonuses, applied on top of your rolled/array stats — the confirm screen shows base vs. final so you can see exactly what your race added:
  - Human — +1 to every ability score
  - Elf — +2 DEX, +1 WIS
  - Dwarf — +2 CON, +1 STR
  - Halfling — +2 DEX, +1 CHA
  - Half-Orc — +2 STR, +1 CON
  - Tiefling — +2 CHA, +1 INT
- **Backgrounds** add a small mechanical bonus and a fact the DM remembers and can weave into the story from the very first scene:
  - Soldier — an old service blade
  - Scholar — starts knowing a lore hook worth investigating
  - Outlaw — 10 extra starting gold
  - Acolyte — a healing draught
  - Wanderer — a traveler's kit

## Scrolling the story log

The story log always fits your terminal exactly — nothing ever spills into your terminal's own scrollback.

| Keys | What they do |
|---|---|
| `PgUp` / `PgDn` | Scroll the log up/down by half a screen |
| `[` / `]` | Same as PgUp/PgDn — works while the DM is narrating; disabled while you're typing so brackets in your own text type normally |

Scrolling up shows a dim `▼ … newer text below` marker while new narration keeps arriving underneath. Submitting an action (or the DM starting a fresh reply) snaps you back to the bottom automatically.

## Slash commands

Type these instead of an action:

| Command | What it does |
|---|---|
| `/sheet` | Show your full character sheet — stats, HP, XP, gold, luck, inventory, quests, location |
| `/journal` | Show the story so far and every chapter summary |
| `/save` | Save your progress right now |
| `/retire` | Retire your hero and raise a new one in this same persistent world |
| `/quit` | Save and exit |
| `/help` | List these commands (and the scroll/roll keys above) in-game |

## Playing on your phone

The same campaign, in your phone's browser — no app to install. Campaigns are still created in the terminal (`npm run play`); phone/web mode is for **continuing and playing** an existing one from your couch.

1. On the computer where your saves live, run:
   ```
   npm run serve
   ```
   This starts a small local web server and prints a box with a URL and a PIN, e.g.:
   ```
   http://192.168.1.23:3123
   PIN: 482913
   ```
2. On your phone (same Wi-Fi), open that address in any browser.
3. Enter the PIN shown in the terminal — your phone remembers it after that.
4. Pick a campaign to **Continue** and play: streaming narration, the same interactive dice (tap the ROLL button; tap REROLL to spend a luck point), tap-to-expand character/world stats, and the same slash commands (`/help`, `/sheet`, `/journal`, `/save`).

**Options:** `--port 4000` (default `3123`), `--host 127.0.0.1` (default `0.0.0.0`, all interfaces), `--no-pin` (skip the PIN — only on a network you fully trust), `--debug` (same raw-SDK logging as the TUI's `--debug`).

**Playing away from home:** your phone just needs to reach the machine running `npm run serve`. The simple, safe way is a personal mesh VPN like [Tailscale](https://tailscale.com) — install it on both ends and browse to the Tailscale address instead of the LAN one.

> **Never port-forward this to the raw internet.** The PIN is a 6-digit lock, not real authentication — no rate-limiting, no HTTPS, nothing else standing between "reaches this port" and "can spend your Claude usage and read/write your saves." LAN or a private VPN (Tailscale), always.

**What's different from the terminal:**
- No new-campaign wizard on web — build characters in the terminal, then continue them from your phone.
- `/retire` and `/quit` aren't available on web yet — they answer with a note pointing back at the terminal. Just close the tab to stop playing; progress is already saved after every turn.
- Only one device drives a campaign at a time — opening it on your phone while it's already running elsewhere just joins the existing session instead of starting a second one.
- Everything else (the DM, the dice, the "forever" memory system, the save files) is the identical game underneath — the phone is just a second window into it.

## Death

Death is meant to land — the DM is instructed to make it a real, dramatic scene, not a stat-block formality. When your hero falls, the world doesn't end with them: type `/retire` to build a brand-new hero (name, class, race, background, stats) and step into the same campaign, the same world, the same history, picking up right where the story left off — just with someone new carrying it forward.

## Choosing the DM model

The game reads `settings.json` at the repo root to decide which Claude model narrates. It's created automatically the first time you launch the game, with sensible defaults:

```json
{
  "dmModel": "haiku",
  "summarizerModel": "haiku"
}
```

Edit it and relaunch to change models. Valid values for both fields: `"default"`, `"haiku"`, `"sonnet"`, `"opus"`.

- **`dmModel`** — the model that narrates and plays the DM every turn. `haiku` is the fastest and cheapest option and is the default; `sonnet`/`opus` give richer, more nuanced narration at a higher cost-per-turn; `"default"` omits the setting entirely and falls back to whatever model your Claude Code install itself defaults to.
- **`summarizerModel`** — the model that condenses old chapters into the chronicle rollup (see below). This runs far less often than the DM, so `haiku` is almost always the right choice regardless of what you pick for `dmModel`.

The file is gitignored — it's a local preference, not something that ships with the repo or a save. If it's ever missing or malformed, the game falls back to the `haiku`/`haiku` defaults automatically and tells you so in-game rather than crashing.

A single campaign can still pin its own model by hand-editing `"modelOverride": "opus"` into that campaign's `saves/<slug>/campaign.json` — when set, it takes priority over `settings.json` for that campaign only.

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

**Which Claude model runs the game, and can I change it?**
See [Choosing the DM model](#choosing-the-dm-model) above — it's controlled by `settings.json` (haiku by default), with an optional per-campaign override.

**Is there a debug mode?**
`npm run play -- --debug` logs every raw message from the Agent SDK to `saves/<slug>/debug.log`, useful if something looks off and you want to see exactly what the DM's session sent and received.

**How do I run the tests?**
`npm test` runs the full test suite (engine math, saves, the memory system, etc.) — no AI calls, no billing.

## For developers

```
src/
  game/     dice, engine (state mutations + validation), saves + schema migration,
            character-creation math (classes/races/backgrounds), settings.json loader
  ai/       Agent SDK session wrapper, DM system prompt + context-brief builder, MCP tool layer, chronicle summarizer
  ui/       ink components: App shell, bounded story log + pure line-wrapping, sidebar,
            input bar, interactive roll prompt, wizard
  web/      phone/web mode: bridge.ts (pure ControllerCallbacks -> SSE-event mirror),
            server.ts (PIN-gated HTTP/SSE routes over plain `http`, no framework),
            serve.ts (CLI entry), index.html (single-file mobile UI, no build step)
```

The engine owns every mechanical rule; the AI layer only narrates and calls tools the engine validates. The web server is a second front end on top of the exact same `GameController` the TUI uses — see `src/web/bridge.ts`'s header comment. See `PLAN.md` for the full design writeup.

- `npm test` — the full vitest suite, no AI calls.
- `npm run typecheck` — `tsc --noEmit`.
- Three smoke scripts prove the real Agent SDK integration end-to-end. The first is free; **the other two bill real turns** against whatever account is logged in:
  - `npm run spike` — ~30-line proof that subscription auth + streaming + an in-process MCP tool all work. Cheap (one short turn).
  - `npm run smoke` — headless proof that a full DM turn narrates, calls tools, mutates state, and autosaves. Bills a few real turns.
  - `npm run smoke:memory` — headless proof of the chronicle + session-rotation system end to end. Bills several real turns, including at least one haiku summarizer call.
