# AI Dungeon Master

A Dungeons & Dragons campaign, run by Claude, that lives in your browser (phone or desktop) — and never has to end. You play a hero; Claude is the Dungeon Master, narrating the world and deciding what NPCs do. It runs on **your own Claude Code subscription** (no API key, nothing to pay for separately), and the dice, hit points, XP, gold, and inventory are all real code the DM narrates around but can never quietly rewrite. Play a scene, close the tab whenever, and pick up exactly where you left off — the game remembers everything, forever, through a chronicle system that keeps old chapters summarized so the DM's memory never runs out.

**`npm run serve` is the way to play** — the whole game (create a campaign, roll stats, play, retire) lives in a phone/desktop browser now. The original terminal UI (`npm run play`) still works but is legacy/unsupported: new work lands on web first.

## What it looks like

The terminal (legacy) UI, for reference — the web UI has its own BG3-inspired look:

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
npm run serve
```

The folder name has a space in it, so keep the quotes around `"D&D AI"` when you `cd` into it.

`npm run serve` starts a small local web server and prints a box with a URL and a PIN, e.g.:
```
http://192.168.1.23:3123
PIN: 482913
```
Open that address in any browser (same computer or your phone on the same Wi-Fi), enter the PIN, and you're in — the campaigns screen lets you **continue** an existing campaign (each listed with its hero, level, HP and current location), start a **new campaign** (full wizard: name, hero, class, race, background, stats, theme, content rating), or retire a fallen hero into a fresh one. See [Playing on web/phone](#playing-on-webphone) below for the full details, options (`--port`, `--host`, `--no-pin`), and playing away from home.

Prefer a terminal? `npm run play` still runs the original ink-based terminal UI, but it's legacy/unsupported at this point — the wizard, dice, and polish all land on web first now.

## How it plays (terminal, legacy)

- Type what your character does in plain English — "I search the chest," "I try to talk my way past the guard," "I attack the wolf." There's no special syntax to learn.
- Whenever the outcome is uncertain, the DM rolls dice — for real, in code — and narrates around the result. Hit points, XP and leveling, gold, and inventory are all tracked the same way: the DM describes the fiction, but the numbers are computed by the game engine, not by the model, so it can't quietly fudge a roll or hand your character an item you don't have.
- Progress autosaves after every change, not just at the end of a turn — a mid-scene crash loses at most a line of narration, never your character's state.
- Quit anytime (`/quit`, or just close the terminal). **Continue** from the main menu resumes mid-scene next time.
- The campaign never truly ends. As the conversation grows, the game quietly summarizes older chapters into a running "story so far" and starts a fresh session behind the scenes — so the DM's memory of your world never degrades, no matter how many sessions you've played.

## Rolling the dice (terminal, legacy)

The web UI has its own BG3-style d20 (see [Playing on web/phone](#playing-on-webphone)); this section describes the terminal's cycling-die version. Whenever *your hero* attacks, makes a skill check, or saves against something, the game pauses and hands the die to you:

1. A prompt appears where the dice line usually sits: `🎲 Persuasion — DC 13 — press SPACE to roll` (the DC is the number you need to meet or beat; it's omitted for rolls with no real stakes).
2. Press **SPACE** or **Enter** — the die face cycles for a moment, then the real result (rolled in code, never by the model) is revealed: `🎲 d20+3 (Persuasion) → [14]+3 = 17 vs DC 13 — ✓ success`.
3. If the roll **fails** its DC and you still have luck left, you're offered a reroll: `✦ Luck 2 — press L to reroll, Enter to accept`. Spending luck rerolls the same roll and keeps whichever total is better — win or lose, that luck point is gone either way. Every hero starts with 1 luck and gains another on each level-up, capped at 3.
4. The DM narrates around whatever actually happened — including a bit of "fate intervened" flavor when a luck reroll saved the day.

NPCs, monsters, and the world roll their own dice too (behind the scenes, instantly) — only the hero's own rolls pause for a button press.

While the game is idle or the DM is narrating, the input bar shows what's happening; Esc interrupts a rambling DM turn, but does nothing while a roll is waiting on you (so it can never cancel a roll by mistake).

## Character creation

Both UIs run the same wizard order: campaign name, hero name, **class**, **race**, **background**, ability scores, world theme, and content rating (the terminal shows a one-line tooltip per option; the web wizard shows the same details inline).

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

## Scrolling the story log (terminal, legacy)

The story log always fits your terminal exactly — nothing ever spills into your terminal's own scrollback. (The web feed just scrolls normally, like any web page.)

| Keys | What they do |
|---|---|
| `PgUp` / `PgDn` | Scroll the log up/down by half a screen |
| `[` / `]` | Same as PgUp/PgDn — works while the DM is narrating; disabled while you're typing so brackets in your own text type normally |

Scrolling up shows a dim `▼ … newer text below` marker while new narration keeps arriving underneath. Submitting an action (or the DM starting a fresh reply) snaps you back to the bottom automatically.

## Slash commands

Type these instead of an action (both UIs support `/help`, `/sheet`, `/journal`, `/save`; `/retire` and `/quit` are terminal-only text commands — on web, use the **Retire hero** action and just close the tab instead):

| Command | What it does |
|---|---|
| `/sheet` | Show your full character sheet — stats, HP, XP, gold, luck, inventory, quests, location |
| `/journal` | Show the story so far and every chapter summary |
| `/save` | Save your progress right now |
| `/retire` | Retire your hero and raise a new one in this same persistent world |
| `/quit` | Save and exit |
| `/help` | List these commands (and the scroll/roll keys above) in-game |

## Playing on web/phone

This is now the whole game, in any browser (phone or desktop) — nothing to install beyond `npm run serve` on the machine where your saves live.

1. On that machine, run:
   ```
   npm run serve
   ```
   This starts a small local web server and prints a box with a URL and a PIN, e.g.:
   ```
   http://192.168.1.23:3123
   PIN: 482913
   ```
2. On your phone or another computer (same Wi-Fi), open that address in any browser.
3. Enter the PIN shown in the terminal — your device remembers it after that.
4. From the campaigns screen: **Continue** an existing campaign — each one shows the hero you left off as (name, race, class, level), their HP, and where they're standing — or **Begin a new campaign** to run the full wizard (campaign name, hero name, class, race, background, ability scores — standard array or roll 4d6 — world theme, content rating) right there in the browser. In play: streaming narration (the DM's *emphasis* renders as italics rather than raw asterisks), BG3-style d20 dice (tap to roll, tap REROLL to spend a luck point), a "YOU GAINED" toast whenever gold/items/XP land, tap-to-expand character/world stats (quests show their estimated reward), a **Retire hero** action to raise a new hero in the same persistent world, and the same slash commands (`/help`, `/sheet`, `/journal`, `/save`).

**Options:** `--port 4000` (default `3123`), `--host 127.0.0.1` (default `0.0.0.0`, all interfaces), `--no-pin` (skip the PIN — only on a network you fully trust), `--debug` (same raw-SDK logging as the legacy terminal's `--debug`).

**Playing away from home:** see [Play from your phone anywhere (remote access)](#play-from-your-phone-anywhere-remote-access) below for two ways to reach this server from any network — a private Tailscale VPN (recommended) or a disposable public Cloudflare tunnel (`npm run serve:remote`) — plus how to keep the laptop awake while you play.

> **Never port-forward this on your router to the raw internet.** That exposes it permanently at a fixed address with nothing standing between "reaches this port" and "can spend your Claude usage and read/write your saves" beyond the PIN — still just a 6-digit lock, not real authentication, even though it's now rate-limited against brute force (see below). Use Tailscale or the disposable Cloudflare quick tunnel instead — both reach this same server without ever opening your router up.

**Good to know:**
- Only one device drives a campaign at a time — opening it on a second device while it's already running elsewhere just joins the existing session instead of starting a second one.
- Everything (the DM, the dice, the "forever" memory system, the save files) is the identical game underneath, regardless of which device you're on.

## Play from your phone anywhere (remote access)

`npm run serve` only binds your LAN/Wi-Fi, so it works great at home but not from cell data or a friend's house. Two ways to reach it from anywhere, in order of preference:

### Option A: Tailscale (recommended — private, only your own devices)

[Tailscale](https://tailscale.com) is a free personal mesh VPN: it puts your laptop and phone on their own private network. Nothing here is reachable from the public internet — only devices signed into your own Tailscale account.

1. Install Tailscale on **both** the laptop and the phone, and sign in to the **same** account on each.
2. On the laptop, run `npm run serve` as usual.
3. On the phone, open `http://<laptop-tailscale-name>:3123` — Tailscale's MagicDNS resolves `<laptop-tailscale-name>` (the machine name shown in the Tailscale app) without you needing to know its IP. Enter the PIN from the startup box, same as on LAN.

### Option B: Cloudflare quick tunnel (a public URL, zero account needed)

For a quick session without installing anything on the phone:

1. Install `cloudflared` on the laptop: `brew install cloudflared` (macOS). For Linux/Windows, see [Cloudflare's install docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
2. Run `npm run serve:remote` instead of `npm run serve`. It starts the same game server *and* opens a Cloudflare "quick tunnel," then prints a box with a `https://<random>.trycloudflare.com` URL right alongside the PIN.
3. Open that https URL on your phone (any network — cell data, a friend's Wi-Fi, anywhere) and enter the PIN.

No sign-up, no config, nothing installed on the phone — but the URL is public: anyone who has it can reach the server (they'd still need the PIN to do anything). It's unguessable and **changes every time you run it**, so don't post it anywhere public. If `cloudflared` isn't installed, `npm run serve:remote` says so and prints install instructions, falling back to local/LAN-only play (same as plain `npm run serve`) in the meantime.

### Keep the laptop awake

Both options need the laptop to stay powered on and awake for the entire session — closing the lid or letting it sleep drops the connection out from under you. On macOS, open another terminal tab before you start playing and run:
```
caffeinate -s
```
`-s` keeps the machine from idle-sleeping for as long as that command keeps running (leave the tab open; Ctrl+C it when you're done playing). Alternatively, disable sleep for the session in System Settings → Lock Screen/Battery, or just leave the lid open for the duration.

### Security note

The PIN is the only thing standing between "has the URL" and "can play your campaign and spend your Claude usage" — there's no username, no separate login. The per-IP rate-limiting (an IP gets locked out for a minute after 5 consecutive wrong PINs, resetting on a correct one) blunts a script trying to brute-force it, but it's not a substitute for keeping access private:
- **Prefer Tailscale** — it isn't reachable from the public internet at all, so there's no PIN to attack from outside your own devices in the first place.
- If you use the Cloudflare option, don't share the printed URL beyond whoever you actually want playing, and treat each run's URL as disposable — it's gone the moment you stop the server.

## Death

Death is meant to land — the DM is instructed to make it a real, dramatic scene, not a stat-block formality. When your hero falls, the world doesn't end with them: use **Retire hero** (web) or `/retire` (terminal) to build a brand-new hero (name, class, race, background, stats) and step into the same campaign, the same world, the same history, picking up right where the story left off — just with someone new carrying it forward.

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
Run `claude` once in a terminal to log in (any subscription), then relaunch `npm run serve` (or `npm run play` for the legacy terminal UI).

**What does "the weave is exhausted" mean?**
That's the in-fiction version of a rate-limit message — you've hit a temporary usage limit on your plan. Wait a few minutes and try again; your save is untouched.

**Where do saves live? Can I back them up?**
In `saves/<campaign-name>/` at the repo root, as plain JSON files (plus a raw transcript log). Back up a campaign by copying its folder — nothing here is a database or binary format.

**How do I choose PG-13 vs. R content?**
It's a step in the New Campaign wizard, right after you pick a world theme. PG-13 is the default; R allows more mature themes and violence (never sexual content, in either rating).

**Which Claude model runs the game, and can I change it?**
See [Choosing the DM model](#choosing-the-dm-model) above — it's controlled by `settings.json` (haiku by default), with an optional per-campaign override.

**Is there a debug mode?**
`npm run serve -- --debug` (or `npm run play -- --debug` for the legacy terminal UI) logs every raw message from the Agent SDK to `saves/<slug>/debug.log`, useful if something looks off and you want to see exactly what the DM's session sent and received.

**How do I run the tests?**
`npm test` runs the full test suite (engine math, saves, the memory system, etc.) — no AI calls, no billing.

## For developers

```
src/
  game/     dice, engine (state mutations + validation), saves + schema migration,
            character-creation math (classes/races/backgrounds), settings.json loader,
            players.ts (access-code registry + per-player save namespacing)
  ai/       DM session backends (Agent SDK, OpenAI-compatible, dual referee+narrator),
            system prompts + context-brief builder, MCP tool layer, chronicle summarizer
  ui/       ink components: App shell, bounded story log + pure line-wrapping, sidebar,
            input bar, interactive roll prompt, wizard
  web/      phone/web mode: bridge.ts (pure ControllerCallbacks -> SSE-event mirror),
            server.ts (auth-gated HTTP/SSE routes over plain `http`, no framework),
            serve.ts (CLI entry), index.html (single-file mobile UI, no build step)

test/       one file per src module, flat, mirroring the source name. `npm test`
            runs all of it and makes no AI calls.

docs/       PLAN.md (design writeup), DEPLOY.md (cloud/Oracle/Fly runbook),
            the SRD/PRD for the pluggable-backend + cloud work, review-log.md

scripts/
  smoke/    live end-to-end proofs against a REAL model endpoint. These BILL --
            either your Claude plan or your OpenAI-compatible provider. Never
            part of `npm test`.
  admin/    maintenance against saves on disk, all dry-run by default and all
            backing up before they write: players (access codes), rewind,
            fix-item-names, migrate-to-players.
  tunnel.ts `npm run serve:remote` -- the normal server plus a Cloudflare quick
            tunnel. Neither a smoke test nor an admin tool, so it sits on its own.
```

`scripts/` is split by consequence rather than by topic: everything under
`smoke/` costs money when you run it and everything under `admin/` mutates
saves, so the directory name is the warning.

The engine owns every mechanical rule; the AI layer only narrates and calls tools the engine validates. The web server is a second front end on top of the exact same `GameController` the TUI uses — see `src/web/bridge.ts`'s header comment. See `docs/PLAN.md` for the full design writeup.

- `npm test` — the full vitest suite, no AI calls.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run serve:remote` (`scripts/tunnel.ts`) — same server as `npm run serve`, plus an optional Cloudflare quick tunnel for remote access; see [Play from your phone anywhere (remote access)](#play-from-your-phone-anywhere-remote-access).
- Three smoke scripts prove the real Agent SDK integration end-to-end. The first is free; **the other two bill real turns** against whatever account is logged in:
  - `npm run spike` — ~30-line proof that subscription auth + streaming + an in-process MCP tool all work. Cheap (one short turn).
  - `npm run smoke` — headless proof that a full DM turn narrates, calls tools, mutates state, and autosaves. Bills a few real turns.
  - `npm run smoke:memory` — headless proof of the chronicle + session-rotation system end to end. Bills several real turns, including at least one haiku summarizer call.
