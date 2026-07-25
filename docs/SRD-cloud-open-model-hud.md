# SRD — Self-hosted, uncensored, free-to-run AI D&D (cloud game + open-model DM + BG3 HUD)

> Version: V0.1
> Date: 2026-07-23
> Author: Sergiu (owner / DM)
> Status: Draft for review

---

## 1. Customer

- **Primary:** the owner (Sergiu) — runs the game, wants to stop spending Claude subscription tokens on gameplay and to play uncensored, mature content.
- **Secondary:** friends / players the owner invites — should be able to play **from anywhere, on a phone**, without the owner's laptop being on and **without drawing down the owner's Claude tokens**.
- Small, private audience (not a public product). No account system beyond the existing PIN gate.

## 2. Job to be Done

Let the owner and invited players run an endless, mature (uncensored) AI-DM'd D&D campaign **from anywhere, at any time, at (ideally) zero recurring cost**, decoupled from the Claude subscription — presented as a **game**, not a chat app.

## 3. Benefit

### 3.1 Customer value

- **Play from anywhere, laptop off** — a public URL + PIN, no same-Wi-Fi requirement, no tunnel, no keeping a laptop awake.
- **No token drain** — gameplay never consumes the owner's Claude/Anthropic quota; friends can play without costing the owner Claude tokens.
- **Uncensored content** — mature/R-rated themes handled straight, without the model-level "fade to black" ceiling the Claude path imposes.
- **Feels like a game** — a BG3-style HUD (character panel, scene, dice tray, action bar) instead of a chat thread with a status-bar "lip".

### 3.2 Business value

- Not a commercial product; "business" value = **cost control**: move from consuming a paid Claude subscription to a **free-first** stack, with a clear paid upgrade path only if the owner chooses.

### 3.3 Brand impact

> ⚠️ TBD — 待补充 (personal project; no brand dimension).

## 4. Problem

Current state (`/Users/Sergiu/DevG/D&D AI`, Claude Agent SDK + Node web server + terminal legacy):

1. **Token drain.** The DM runs on the Claude Agent SDK using the owner's subscription auth. Every turn — the owner's *and* every invited player's — spends the owner's Claude quota. There is no way for others to play "on their own dime."
2. **Content ceiling.** Even in R-rated mode, explicit acts stay off-page (fade-to-black) — a model-level limit the owner wants removed ("no censorship on any type of content").
3. **Reachability.** The current remote-access answer is a tunnel to the owner's laptop, which requires the **laptop to stay on and awake**. The owner wants true "laptop closed, play from anywhere."
4. **UI reads like a chatbox.** The recent redesign still presents play as chat bubbles with a thin top status strip ("an upper lip for player info") — it does not feel like a game.
5. **Resume bug (confirmed).** On opening a save, the **character panel (HP/AC/gold/inventory/quests/location) stays empty until the player sends a first message.** Root cause: the resume fix stopped the DM from taking an auto-turn on load, and the character panel had only ever been populated as a *side effect* of a tool call during that turn. No turn → no state event → empty panel. (Fix is small; see §9.)

## 5. Solution

Replace the Claude-bound DM with a **pluggable, OpenAI-compatible model backend**, host the whole game on a **free, always-on cloud host**, and rebuild the play UI as a **game HUD**.

### 5.1 Benchmark Analysis

- **AI backend abstraction:** the OpenAI Chat Completions API + tool/function-calling is the de-facto standard. Ollama, OpenRouter, Groq, LM Studio, vLLM, and self-hosted servers all expose an OpenAI-compatible endpoint. Coding to that one interface makes the model a **config value** (base URL + API key + model name), not a code dependency.
- **Free-first stack (starting point, all swappable):**
  - **Game server + saves:** Oracle Cloud *Always Free* ARM VM (genuinely free, always-on, no GPU needed — the Node server is light). Alternatives: Fly.io free allowance, Render free (note: free web services sleep on idle — bad for a persistent connection).
  - **AI endpoint (uncensored, free tier):** OpenRouter free community models, or Ollama Cloud free tier, or a self-hosted Ollama on a spare/rented box. All OpenAI-compatible.
- **UI:** Baldur's Gate 3's in-game presentation (portrait + character panel, scene as the focus, dice tray, action bar) — the reference the owner named.

### 5.2 Before / After

| | Current | Target |
|---|---|---|
| DM model | Claude via Agent SDK (subscription auth) | Any OpenAI-compatible endpoint (Ollama/OpenRouter/self-host), configurable |
| Cost of play | Owner's Claude tokens, always | Free-first; $0 recurring on the starter stack; upgrade optional |
| Content | R-rated with fade-to-black ceiling | Uncensored (owner's chosen model/host) |
| Reach | Laptop + tunnel, laptop must stay awake | Public URL, laptop off, no tunnel |
| Player info on load | Empty until first message | Visible immediately on opening a save |
| Play UI | Chat bubbles + top status strip | BG3-style HUD (panel + scene + dice tray + action bar) |

### 5.3 Scope (In / Out)

| In Scope (this effort) | Out of Scope (not now) |
|---|---|
| Abstract the DM behind an OpenAI-compatible chat + tool-calling client | Keeping the Claude Agent SDK as the play-time DM |
| Configurable endpoint: base URL + API key + model, per-campaign override | A custom model-training / fine-tuning pipeline |
| Re-expose the 11 engine tools as OpenAI function schemas; keep Engine/GameController/GameBridge unchanged | Rewriting the deterministic Engine or save format |
| Move summarizer (chronicle) to the same endpoint | Multi-tenant accounts / per-player billing / user management |
| Cloud-host game server + saves on a free always-on host; drop the tunnel | A paid managed GPU by default (only as an opt-in upgrade) |
| Fix the resume/player-info bug (emit state on load) | Voice / image generation |
| Rebuild play UI as a BG3-style HUD (retire chat-bubble layout) | Native mobile app (stays a web app) |
| Keep PIN gate + IP rate-limiting; HTTPS on the host | Full auth system (OAuth, per-user logins) |

### 5.4 Phasing

Ordered so the highest-value, lowest-risk wins land first. Each phase is independently shippable.

| Phase | Scope | Goal | Depends on |
|---|---|---|---|
| **P1 — Off Claude + bug fix** | Pluggable OpenAI-compatible DM backend (chat + tool-calling) behind the existing `DmSession` seam; summarizer likewise; configurable endpoint/model; **fix resume/player-info bug**. Validate with a mechanics smoke against a **free** endpoint. | Gameplay spends **0 Claude tokens**; uncensored model works; mechanics reliable enough; player info shows on load. | — |
| **P2 — Cloud, no tunnel** | Deploy game server + saves to a free always-on host; public URL; keep PIN + rate-limit + HTTPS; retire `serve:remote`/tunnel. | Play from anywhere, **laptop off**, no tunnel. | P1 |
| **P3 — BG3 HUD** | Replace the chat-bubble + status-strip play screen with a game HUD (character/portrait panel, scene focus, dice tray, action bar). Keep the d20 and loot/quest work already built. | Play reads as a game, not a chatbox. | P1 (P2 optional) |

## 6. Success Metrics

| Type | Metric | Target |
|---|---|---|
| Core | Claude/Anthropic tokens consumed during play | **0** |
| Core | Recurring cost of the starter stack | **$0** (free tiers); any cost is opt-in and documented |
| Core | Reachable from a public URL with owner's laptop **off** | Yes |
| Core | Player info (HP/AC/gold/inventory/quests/location) visible **immediately** on opening a save | Yes (bug fixed) |
| Observation | Mechanics reliability on the chosen free model — DM calls the right tool when it should (rolls on uncertain actions; loot/XP/quests recorded) | High enough to be playable; measured via the existing `npm run smoke`-style live check |
| Observation | Uncensored content produced without refusal | Yes |
| Observation | Turn latency on the free endpoint | Playable (turn-based tolerance; document if a free tier is too slow) |

## 7. Risks & Mitigation

| Type | Risk | Mitigation |
|---|---|---|
| Technical | **Free + uncensored + reliable-tool-calling is a tight triangle.** Free/small uncensored models often skip `roll_dice`/`add_item`/`award_xp` → flaky mechanics (the game's core depends on tool-calls). | Configurable endpoint = instant upgrade path; force-tool prompting + output validation + one retry when a consequential turn made zero tool calls; a mechanics smoke gates each model choice. Prove a specific free model works before committing (early spike). |
| Technical | **Migration off the Agent SDK is substantial** — different tool-call format, streaming, agentic loop. | Keep `Engine`/`GameController`/`GameBridge` untouched; swap only inside the `DmSession` seam behind the same callback surface; phase it (P1 first). |
| Operational | **Free-tier limits** — rate caps, model deprecation, or free hosts that sleep on idle (cold starts break a persistent SSE feel). | Prefer a genuinely always-free, no-sleep host (Oracle Always-Free VM) for the server; design for retries/backoff; document each free tier's ceiling; make model/endpoint swappable. |
| Content / legal | Even "uncensored" hosts/providers have acceptable-use terms; some free endpoints log or train on submitted data. | Owner chooses the endpoint; document the privacy/ToS trade-off; self-hosting the model gives full control if that matters. (Factual, owner's call.) |
| Security | Public URL is now truly internet-facing; PIN is the only gate. | Keep IP rate-limiting (already built); HTTPS via the host; consider a longer secret than 6 digits for a public deployment; never index/share the URL. |
| Product | A fully-free model may simply be too weak for satisfying play. | Set an explicit "playable quality" bar in the P1 smoke; if no free model clears it, surface the cheapest paid option that does and let the owner decide (free stays the default). |

## 8. Feedback Loops

### 8.1 Stakeholders

- **Key stakeholder:** the owner (also the only decision-maker). Players give informal feedback in-session.
- **Tracking:** issues/decisions captured in this repo's `docs/`.

### 8.2 A/B Testing

> ⚠️ TBD — not applicable (single private deployment).

### 8.3 Before/After Data

- Compare: Claude tokens/turn (before) → 0 (after); reachability (laptop-on+tunnel → public URL laptop-off); "player info on load" broken → fixed.

## 9. Product Requirements (summary; detail belongs in a PRD)

- **PR-1 Pluggable DM backend.** A model client that speaks OpenAI-compatible Chat Completions **with tool/function calling**, drop-in behind the current `DmSession`. Config: `baseUrl`, `apiKey` (optional for local), `model`; per-campaign override honored. Streaming preserved for the typing feel.
- **PR-2 Tool bridge.** The 11 engine tools (roll_dice, apply_damage, heal, award_xp, modify_gold, add_item, remove_item, upsert_quest, upsert_npc, set_location, record_fact) re-expressed as OpenAI function schemas; the interactive player-roll pause/confirm/luck flow preserved.
- **PR-3 Reliability guardrails.** Force-tool prompting; validate that consequential turns produced the expected tool calls; single retry/nudge on violation; keep the per-turn mechanics reminder.
- **PR-4 Summarizer.** Chronicle summarization uses the same endpoint (no Claude dependency).
- **PR-5 Resume bug.** On opening/continuing a save, push current character + world state to the UI immediately (independent of any DM turn) so the panel is populated on load.
- **PR-6 Cloud deploy.** Game server + saves run on a free always-on host; public URL; PIN + rate-limit + HTTPS; tunnel path retired.
- **PR-7 Config & secrets.** Endpoint/key/model configured via env/settings, not committed; safe defaults for local dev.

## 10. UI/UX Requirements (summary; detail belongs in a PRD)

- **UX-1 Retire the chatbox.** No left/right message bubbles and no thin top status strip as the primary layout. Play is a **HUD**.
- **UX-2 BG3-style HUD.** Persistent character/portrait panel (name, HP/AC/gold/luck/XP, inventory, quests+rewards, location); the **scene/narration as the visual focus**; a **dice tray** (reuse the existing 3D d20 + reveal); an **action/input bar** styled as a game control, not a chat composer.
- **UX-3 Player info on load.** The HUD shows full character state the instant a save opens (ties to PR-5).
- **UX-4 Keep what works.** Preserve the d20 roll flow, loot toasts, quest-reward display, and the "Ember & Vellum" art direction / embedded fonts; change the *layout paradigm*, not the identity.
- **UX-5 Responsive.** Phone-first (primary), with the HUD adapting to desktop; keyboard focus + reduced-motion respected.

---

### Open items to resolve before/inside the PRD

1. **Pick and prove the free endpoint+model** (early spike): confirm an actual free, uncensored, tool-calling-capable model that clears the mechanics-smoke bar. This is the single biggest unknown.
2. **Confirm the free host** (Oracle Always-Free VM vs alternatives) and the deploy method.
3. **HUD detail** (exact panels, mobile vs desktop composition, portrait source — art vs generated vs none).
