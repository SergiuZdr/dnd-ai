// The turn loop: wires the deterministic Engine to a DmSession and reports
// everything back through a small, UI-free callback surface so the ink layer
// (or a test) never has to know about the Agent SDK, saves, or timers.
//
// Construction is side-effect-free — Engine/DmSession/timers are only created
// once start() is called. That keeps `new GameController(...)` safe to use in
// tests (or anywhere) without ever touching disk or the network.
//
// This file also owns the "forever" memory system: once the un-summarized
// tail of the transcript crosses a threshold (shouldSummarize), a one-shot
// cheap-model call (summarizeFn) condenses it into a chapter + updated
// story-so-far rollup persisted in chronicle.json, then the DM session is
// quietly ended and a fresh one started (runChronicleUpdate). The fresh
// session does NOT get a context brief right away -- re-narrating a scene
// the player is already in would be jarring and bills a wasted turn. Instead
// the brief is held as `pendingBrief` and prepended to the player's next
// action (submitPlayerAction / sendToSession).

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GameState, LedgerDelta } from './state';
import { Engine, formatRollDetail } from './engine';
import type { EngineResult } from './engine';
import type { RollResult } from './dice';
import { createDmTools } from '../ai/tools';
import type { InteractiveRollRequest } from '../ai/tools';
import { dmSystemPrompt, buildOpeningPrompt, buildContextBrief, buildNewHeroPrompt, withMechanicsReminder } from '../ai/prompts';
import { DmSession } from '../ai/dm';
import type { DmError, DmSessionCallbacks, DmSessionConfig } from '../ai/dm';
import { OpenAiDmSession } from '../ai/openaiDm';
import { DualModelDmSession } from '../ai/dualDm';
import { summarizeChunk } from '../ai/summarizer';
import { splitSuggestions, visibleStreamText } from '../ai/suggestions';
import { saveGame, appendTranscript, readTranscript } from './saves';
import type { TranscriptEntry } from './saves';
import { loadSettings } from './settings';

export interface StoryEntry {
  id: number;
  kind: 'player' | 'dm' | 'system';
  text: string;
}

/** Re-exported so callers can import it from either state.ts (its home) or here alongside ControllerCallbacks. */
export type { LedgerDelta };

/** A player-triggered dice roll awaiting SPACE/Enter in the UI. Mirrors InteractiveRollRequest (ai/tools.ts) minus nothing -- kept as a separate type so the UI layer never has to import from ai/. */
export type PendingRollRequest = InteractiveRollRequest;

/** Dice-faces + modifier text only, e.g. "[7]" or "[7]+3" -- no total (that's RollDetail.total, kept separate so the UI composes its own layout instead of parsing a formatted string). */
export interface RollDetail {
  text: string;
  total: number;
}

/**
 * What confirmRoll()/resolvePendingRoll() hand back to the UI once a real,
 * engine-rolled result is in. Structured on purpose (not just `message`):
 * the DM can send an arbitrarily long `reason`, and a UI that builds its
 * display by concatenating reason+numbers into one string risks truncating
 * the numbers themselves off screen. Structured fields let the UI put the
 * numbers on their own row, which can never be pushed out by the reason.
 * `message` is kept too -- unchanged, full-detail -- for anything that just
 * wants the one-line summary (e.g. the transcript-facing onDiceRoll pipeline
 * reuses the same string engine.rollDice already produced).
 */
export interface RollRevealResult {
  message: string;
  expr: string;
  /** As sent by the DM. Short by convention (see ai/tools.ts, ai/prompts.ts) but the UI defensively truncates regardless -- never assume it's short. */
  reason: string;
  first: RollDetail;
  /** Present only once a luck reroll has happened. */
  reroll?: RollDetail;
  /** The better of first.total and reroll.total (equals first.total when there was no reroll). */
  keptTotal: number;
  dc?: number;
  /** Defined only when dc is known. */
  success?: boolean;
  /** True while still awaiting a luck decision (roll executed, failed its dc, hero has luck left). */
  canReroll: boolean;
  /** Current luck count, for the "✦ Luck N — press L to reroll" prompt text. */
  luck: number;
}

export interface ControllerCallbacks {
  /** Completed entries only — never called with a partial/in-flight turn. */
  onStoryAppend: (entry: StoryEntry) => void;
  /** Full accumulated partial text for the in-flight DM turn; '' once the turn completes. */
  onStreamText: (partial: string) => void;
  onStateChange: (state: GameState) => void;
  onDiceRoll: (message: string) => void;
  onToolActivity?: (toolName: string) => void;
  /**
   * Fires once per successful gain/loss tool call (modify_gold / award_xp /
   * add_item / remove_item) with a structured delta -- see LedgerDelta.
   * Optional so an implementer that has no use for it keeps compiling
   * unchanged: GameBridge implements it (the web client's "YOU GAINED" toast),
   * while the legacy ink TUI's App.tsx omits it and simply gets no toasts --
   * the sidebar already shows the resulting numbers there.
   */
  onLedgerGain?: (delta: LedgerDelta) => void;
  /**
   * The DM's suggested next actions for the scene just narrated (0-3 short
   * labels), or an empty array to clear them -- fired on every turn completion
   * and when the player acts, so stale chips from the previous scene can never
   * linger. Optional: the ink TUI omits it and simply shows no chips.
   */
  onSuggestions?: (actions: string[]) => void;
  onBusyChange: (busy: boolean) => void;
  /** Friendly errors, rate-limit notes, interrupt confirmations. */
  onSystemNote: (note: string) => void;
  /** A player roll is awaiting SPACE/Enter (request), or has just been resolved/cancelled (null). */
  onRollPrompt: (request: PendingRollRequest | null) => void;
  /**
   * Called once, synchronously, at the top of start('resume'|'new-hero') --
   * before anything is sent to the DM -- with the un-summarized transcript
   * tail replayed as StoryEntry so the player sees their own actual prior
   * scene (byte-identical) instead of relying on a freshly-prompted DM
   * session to reproduce it from memory. Never called for start('new').
   */
  onHistoryReplay: (entries: StoryEntry[]) => void;
}

/**
 * The minimal surface the controller needs from a DM session. `DmSession`
 * satisfies this structurally; tests supply fakes instead.
 */
export interface DmSessionLike {
  start(): void;
  send(playerText: string): void;
  interrupt(): Promise<void>;
  end(): Promise<void>;
  readonly busy: boolean;
}

export interface GameControllerOptions {
  baseDir?: string;
  /** Char threshold for the un-summarized transcript tail. Default 24000. */
  summarizeThresholdChars?: number;
  /** Entry-count threshold (player+dm only) for the un-summarized tail. Default 40. */
  summarizeThresholdEntries?: number;
  /** Cheap-model override for the summarizer. Default: read from settings.json (see src/game/settings.ts), itself 'haiku' unless configured. */
  summarizerModel?: string;
  /** Test seam: replaces `new DmSession(...)`. Defaults to constructing a real DmSession. */
  sessionFactory?: (config: DmSessionConfig, callbacks: DmSessionCallbacks) => DmSessionLike;
  /** Test seam: replaces the real chronicle summarizer call. */
  summarizeFn?: typeof summarizeChunk;
  /** When true, every raw SDK message is appended to saves/<slug>/debug.log. Default false. */
  debug?: boolean;
}

const SAVE_DEBOUNCE_MS = 300;
// Stream-delta batching interval: how often onStreamText re-renders the
// in-flight DM turn. Raised from 50ms -- 80ms is still imperceptible as
// narration but roughly halves React/ink re-render churn during long turns.
// handleTurnComplete() always flushes/clears immediately on completion
// (bypassing this throttle entirely), so no trailing text is ever lost.
const STREAM_THROTTLE_MS = 80;
const DEFAULT_SUMMARIZE_THRESHOLD_CHARS = 24000;
const DEFAULT_SUMMARIZE_THRESHOLD_ENTRIES = 40;

/**
 * Pure threshold check: does the un-summarized tail of the transcript
 * (player + dm roles only, everything strictly after `lastSummarizedIndex`)
 * warrant a chronicle update? True once its total text length crosses
 * `thresholdChars` (raw characters, not tokens -- thresholds are already
 * expressed in chars) OR its entry count crosses `thresholdEntries`.
 */
export function shouldSummarize(
  entries: TranscriptEntry[],
  lastSummarizedIndex: number,
  thresholdChars: number,
  thresholdEntries: number,
): boolean {
  const unsummarized = entries
    .slice(lastSummarizedIndex)
    .filter((entry) => entry.role === 'player' || entry.role === 'dm');
  const totalChars = unsummarized.reduce((sum, entry) => sum + entry.text.length, 0);
  return totalChars >= thresholdChars || unsummarized.length >= thresholdEntries;
}

/**
 * The real (non-test) sessionFactory: reads settings.json's `dmBackend` and
 * constructs the matching DmSessionLike. 'claude' (the default, so a
 * settings.json that predates P1 -- or has none at all -- behaves exactly
 * as before) builds the existing Agent SDK-backed DmSession; 'openai' builds
 * OpenAiDmSession (src/ai/openaiDm.ts), which drives an OpenAI-compatible
 * endpoint instead; 'dual' builds DualModelDmSession (src/ai/dualDm.ts),
 * which splits mechanics (a reliable tool-calling "referee" model) from
 * narration (a separate, more permissive "narrator" model) across the same
 * endpoint. All three share the exact same DmSessionConfig/
 * DmSessionCallbacks shape, so nothing else here needs to know which one it
 * got back.
 *
 * Exported (in addition to being GameController's own default sessionFactory
 * value) so a test can exercise the dmBackend -> class selection directly
 * without needing a full GameController + real settings.json on disk --
 * see test/defaultSessionFactory.test.ts.
 */
export function defaultSessionFactory(config: DmSessionConfig, callbacks: DmSessionCallbacks): DmSessionLike {
  const { settings } = loadSettings();
  if (settings.dmBackend === 'dual') return new DualModelDmSession(config, callbacks);
  if (settings.dmBackend === 'openai') return new OpenAiDmSession(config, callbacks);
  return new DmSession(config, callbacks);
}

export class GameController {
  private readonly state: GameState;
  private readonly cb: ControllerCallbacks;
  private readonly baseDir: string | undefined;

  private readonly summarizeThresholdChars: number;
  private readonly summarizeThresholdEntries: number;
  /** undefined -> summarizeChunk() falls back to settings.json itself; see GameControllerOptions.summarizerModel. */
  private readonly summarizerModel: string | undefined;
  private readonly sessionFactory: (config: DmSessionConfig, callbacks: DmSessionCallbacks) => DmSessionLike;
  private readonly summarizeFn: typeof summarizeChunk;
  private readonly debug: boolean;

  private engine?: Engine;
  private session?: DmSessionLike;
  private sessionConfig?: DmSessionConfig;
  private sessionCallbacks?: DmSessionCallbacks;

  private nextStoryId = 1;
  private busy = false;

  private dirty = false;
  private saveTimer?: ReturnType<typeof setTimeout>;

  private streamBuffer = '';
  private streamTrailingTimer?: ReturnType<typeof setTimeout>;
  private lastStreamEmitAt = Number.NEGATIVE_INFINITY;

  // -- "Forever" memory system state -------------------------------------
  /** True for the whole summarize+rotate cycle (prevents overlapping chronicle updates). */
  private chronicling = false;
  /** True only for the window from ending the old session through starting the new one. */
  private swapping = false;
  /** The in-flight runChronicleUpdate() call, if any -- shutdown() awaits this so it never
   *  races the swap (calling end() on a session the rotation is simultaneously ending/replacing). */
  private rotationPromise?: Promise<void>;
  /** Set right after rotation; prepended to (and cleared by) the player's next action. */
  private pendingBrief?: string;
  /** One-slot queue for an action submitted mid-swap; flushed once the new session is up. */
  private queuedAction?: string;
  /** Drained every time the active session goes idle (turn complete or error). */
  private idleWaiters: Array<() => void> = [];

  // -- Interactive player dice rolls --------------------------------------
  /** Non-undefined for the whole life of one roll_dice(roller:'player') tool call: from the UI prompt through confirm/reroll to resolution. */
  private pendingRoll?: {
    request: PendingRollRequest;
    resolve: (result: EngineResult) => void;
    /** Set once confirmRoll() has executed the real roll; undefined while still waiting on SPACE/Enter. */
    firstRoll?: RollResult;
    firstMessage?: string;
  };

  constructor(state: GameState, cb: ControllerCallbacks, opts?: GameControllerOptions) {
    this.state = state;
    this.cb = cb;
    this.baseDir = opts?.baseDir;
    this.summarizeThresholdChars = opts?.summarizeThresholdChars ?? DEFAULT_SUMMARIZE_THRESHOLD_CHARS;
    this.summarizeThresholdEntries = opts?.summarizeThresholdEntries ?? DEFAULT_SUMMARIZE_THRESHOLD_ENTRIES;
    this.summarizerModel = opts?.summarizerModel;
    this.sessionFactory = opts?.sessionFactory ?? ((config, callbacks) => defaultSessionFactory(config, callbacks));
    this.summarizeFn = opts?.summarizeFn ?? summarizeChunk;
    this.debug = opts?.debug ?? false;
  }

  /** Builds the Engine + DM tools + DmSession and kicks off the first (billed) turn. */
  start(mode: 'new' | 'resume' | 'new-hero'): void {
    const engine = new Engine(this.state);
    engine.onMutation = (state) => {
      this.dirty = true;
      this.scheduleSave();
      this.cb.onStateChange(state);
    };
    this.engine = engine;

    // Push the current state to the UI immediately, before any turn runs.
    // Character/world state otherwise only reaches the UI as a side effect of a
    // tool call (engine.onMutation), so on a `resume` -- which deliberately
    // takes NO DM turn -- the sidebar/top bar would stay empty until the player
    // sent a first message and the DM happened to mutate something. Emitting it
    // here means opening a save shows the full character panel on load, for
    // every mode (also lets the web bridge include state in its broadcastHello).
    this.cb.onStateChange(this.state);

    const { server, allowedTools, tools } = createDmTools(engine, {
      onToolResult: (name, result) => {
        if (name === 'roll_dice' && result.ok) {
          this.cb.onDiceRoll(result.message);
        }
        if (result.ok && result.events.includes('hp-zero')) {
          this.cb.onSystemNote(
            'Your hero has fallen. The DM decides their fate — or type /retire to raise a new hero in this same world.',
          );
        }
        this.cb.onToolActivity?.(name);
      },
      interactiveRoll: (request) => this.handleInteractiveRoll(request),
      onLedger: (delta) => this.cb.onLedgerGain?.(delta),
    });

    this.sessionConfig = {
      systemPrompt: dmSystemPrompt(this.state.campaign.contentRating),
      server,
      allowedTools,
      tools,
      model: this.state.campaign.modelOverride,
      // Unused by DmSession/OpenAiDmSession (both bake contentRating into
      // systemPrompt above already) -- carried for DualModelDmSession
      // (src/ai/dualDm.ts), which builds its own separate referee/narrator
      // system prompts and needs contentRating on its own to do so.
      contentRating: this.state.campaign.contentRating,
      // Likewise dual-only: its narrator has no tools and no engine handle, so
      // it needs the real post-turn numbers to narrate against. Read lazily
      // (not captured) so it always reflects the tool calls just applied.
      stateSnapshot: () => this.state,
    };
    this.sessionCallbacks = {
      onDelta: (text) => this.handleDelta(text),
      onToolUse: (toolName) => this.cb.onToolActivity?.(toolName),
      onTurnComplete: ({ text }) => this.handleTurnComplete(text),
      onSystemNote: (note) => this.cb.onSystemNote(note),
      onError: (err) => this.handleError(err),
      onRawMessage: this.debug ? (msg) => this.appendDebugLog(msg) : undefined,
    };

    this.session = this.sessionFactory(this.sessionConfig, this.sessionCallbacks);

    this.session.start();

    if (mode === 'new') {
      this.setBusy(true);
      this.session.send(buildOpeningPrompt(this.state));
      return;
    }

    const transcript = readTranscript(this.state.campaign.slug, this.baseDir);

    // Replay the un-summarized tail into the story log BEFORE sending
    // anything to the (brand-new, memory-less) DmSession -- the player sees
    // their own actual prior scene verbatim instead of relying on the DM to
    // reproduce it, which invited exactly the kind of restated/re-narrated
    // (and, per dm.ts's appendTurnText fix, sometimes glued-together) scene
    // this replay exists to avoid. Same slice boundary shouldSummarize/
    // runChronicleUpdate already use for "the unsummarized recent tail" --
    // anything older is already captured in chronicle.storySoFar/chapters.
    const unsummarized = transcript.slice(this.state.chronicle.lastSummarizedIndex);
    const replayed: StoryEntry[] = unsummarized.map((entry) => ({
      id: this.nextStoryId++,
      kind: entry.role,
      text: entry.text,
    }));
    this.cb.onHistoryReplay(replayed);

    const brief = buildContextBrief(this.state, transcript);

    if (mode === 'new-hero') {
      this.setBusy(true);
      this.session.send(`${brief}\n\n${buildNewHeroPrompt(this.state)}`);
      return;
    }

    // mode === 'resume': the player already saw their exact prior scene via
    // the replay above -- generating a fresh "next second" DM turn on top of
    // it is exactly the unwanted behavior this fix removes. Hold the brief
    // as pendingBrief (same mechanism the chronicle-rotation path already
    // uses) so it rides along with -- and is only spent by -- the player's
    // NEXT action (see sendToSession); leave the session idle in the
    // meantime. EXCEPTION: if the player quit right after acting and the DM
    // never got to answer (the last player/dm transcript line is a PLAYER
    // line), that action must not be silently dropped -- send the brief now
    // so the DM answers it, same as before this fix.
    const lastPlayerOrDm = [...unsummarized].reverse().find((entry) => entry.role === 'player' || entry.role === 'dm');
    if (lastPlayerOrDm?.role === 'player') {
      this.setBusy(true);
      this.session.send(brief);
    } else {
      this.pendingBrief = brief;
      this.setBusy(false);
    }
  }

  submitPlayerAction(text: string): void {
    if (this.busy) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (!this.session) return;

    this.cb.onStoryAppend({ id: this.nextStoryId++, kind: 'player', text: trimmed });
    appendTranscript(
      this.state.campaign.slug,
      { role: 'player', text: trimmed, ts: new Date().toISOString() },
      this.baseDir,
    );
    // The previous scene's chips describe a moment that has now passed --
    // leaving them up invites the player to tap an action that no longer makes
    // any sense. The next turn supplies its own.
    this.cb.onSuggestions?.([]);
    this.setBusy(true);

    // Wire-only wrapper: transcript and story log above got the clean text;
    // only the DM session sees the trailing mechanics reminder (which also
    // carries the hero's current precomputed modifiers/HP/AC/luck).
    const wire = withMechanicsReminder(trimmed, this.state);

    if (this.swapping) {
      // Old session already ended, the fresh one isn't up yet -- hold the
      // one slot; runChronicleUpdate() flushes it once rotation finishes.
      this.queuedAction = wire;
      return;
    }

    this.sendToSession(wire);
  }

  async interrupt(): Promise<void> {
    if (!this.session) return;
    await this.session.interrupt();
    this.clearPendingRollOnAbort();
    this.cancelStreamThrottle();
    this.streamBuffer = '';
    this.cb.onStreamText('');
    this.setBusy(false);
    this.cb.onSystemNote('Interrupted.');
  }

  /**
   * Called by the UI once the player confirms a pending roll (SPACE/Enter,
   * after its local ~700ms cycling-die animation). Executes the real engine
   * roll and returns the reveal info. If the roll failed its dc and the hero
   * has luck left, the underlying tool-call promise is deliberately NOT
   * resolved yet (canReroll: true) -- the UI must follow up with
   * resolvePendingRoll(); otherwise this has already resolved it and the
   * pending roll is cleared (canReroll: false).
   * Returns undefined only when there was no pending roll to confirm, or the
   * dice expression itself was invalid (a DM bug) -- in the latter case the
   * pending roll is still resolved-with-error and cleared, no UI action needed.
   */
  confirmRoll(): RollRevealResult | undefined {
    const pending = this.pendingRoll;
    if (!pending || !this.engine) return undefined;
    const { request } = pending;
    const result = this.engine.rollDice(request.expr, request.mode, request.reason, request.dc);
    if (!result.ok) {
      this.finishPendingRoll(result);
      return undefined;
    }
    const character = this.engine.state.character;
    const failedDc = request.dc !== undefined && result.roll.total < request.dc;
    const canReroll = failedDc && character.luck > 0;
    if (canReroll) {
      pending.firstRoll = result.roll;
      pending.firstMessage = result.message;
    } else {
      this.finishPendingRoll(result);
    }
    return this.buildReveal(request, result.message, result.roll, character.luck, canReroll);
  }

  /**
   * Called by the UI after a confirmRoll() reveal with canReroll: true.
   * useLuck true = player pressed L (spend 1 luck, keep the better of the two
   * totals); false = accept the original roll as-is (Enter or anything else).
   * Returns the FINAL reveal (post-decision) so the UI can show it without
   * re-deriving anything; undefined only if there's no roll awaiting a luck
   * decision, or the (already-luck-checked) reroll itself somehow errors.
   */
  resolvePendingRoll(useLuck: boolean): RollRevealResult | undefined {
    const pending = this.pendingRoll;
    if (!pending || !this.engine || !pending.firstRoll || pending.firstMessage === undefined) return undefined;
    const { request, firstRoll, firstMessage } = pending;
    if (!useLuck) {
      this.finishPendingRoll({ ok: true, message: firstMessage, events: [] });
      return this.buildReveal(request, firstMessage, firstRoll, this.engine.state.character.luck, false);
    }
    const result = this.engine.rerollWithLuck(firstRoll, request.reason, request.dc);
    this.finishPendingRoll(result);
    if (!result.ok) return undefined;
    return this.buildReveal(
      request,
      result.message,
      firstRoll,
      this.engine.state.character.luck,
      false,
      result.reroll,
    );
  }

  /** Shared RollRevealResult builder for confirmRoll/resolvePendingRoll -- see the type's doc comment for why it's structured instead of just `message`. */
  private buildReveal(
    request: PendingRollRequest,
    message: string,
    first: RollResult,
    luck: number,
    canReroll: boolean,
    reroll?: RollResult,
  ): RollRevealResult {
    const kept = reroll && reroll.total > first.total ? reroll : first;
    return {
      message,
      expr: request.expr,
      reason: request.reason,
      first: { text: formatRollDetail(first), total: first.total },
      reroll: reroll ? { text: formatRollDetail(reroll), total: reroll.total } : undefined,
      keptTotal: kept.total,
      dc: request.dc,
      success: request.dc !== undefined ? kept.total >= request.dc : undefined,
      canReroll,
      luck,
    };
  }

  /**
   * Flushes any pending debounced save synchronously, then ends the DM session.
   * If a chronicle swap is in flight, waits for it to fully finish first --
   * otherwise this could race runChronicleUpdate() and either end a session
   * out from under it mid-swap, or return while rotation is still silently
   * starting a new session nobody will ever shut down.
   */
  async shutdown(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (this.dirty) {
      saveGame(this.state, this.baseDir);
      this.dirty = false;
    }
    if (this.rotationPromise) {
      await this.rotationPromise;
    }
    await this.session?.end();
  }

  /** Sends text to the live session, prepending (and clearing) pendingBrief if one is held. */
  private sendToSession(text: string): void {
    if (!this.session) return;
    if (this.pendingBrief !== undefined) {
      const brief = this.pendingBrief;
      this.pendingBrief = undefined;
      this.session.send(`${brief}\n\n[The player now acts:]\n${text}`);
    } else {
      this.session.send(text);
    }
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.cb.onBusyChange(busy);
  }

  /** The ToolHooks.interactiveRoll implementation: parks the tool call's promise until confirmRoll()/resolvePendingRoll() settles it. */
  private handleInteractiveRoll(request: PendingRollRequest): Promise<EngineResult> {
    return new Promise((resolve) => {
      this.pendingRoll = { request, resolve };
      this.cb.onRollPrompt(request);
    });
  }

  /** Clears the pending roll and resolves its awaited promise -- the one path that actually completes the roll_dice tool call. */
  private finishPendingRoll(result: EngineResult): void {
    const pending = this.pendingRoll;
    if (!pending) return;
    this.pendingRoll = undefined;
    this.cb.onRollPrompt(null);
    pending.resolve(result);
  }

  /**
   * Drops any pending roll WITHOUT resolving its promise -- used when the DM
   * session itself is being interrupted or has errored, so the abandoned
   * tool call's continuation (which would fire onToolResult/onDiceRoll for a
   * turn the UI has already moved past) simply never runs. The promise is
   * left permanently unsettled, which is safe: nothing awaits it once the
   * owning query has been torn down.
   */
  private clearPendingRollOnAbort(): void {
    if (!this.pendingRoll) return;
    this.pendingRoll = undefined;
    this.cb.onRollPrompt(null);
  }

  private handleDelta(text: string): void {
    this.streamBuffer += text;
    const elapsed = Date.now() - this.lastStreamEmitAt;
    if (elapsed >= STREAM_THROTTLE_MS) {
      this.cancelStreamThrottle();
      this.emitStreamNow();
    } else if (!this.streamTrailingTimer) {
      this.streamTrailingTimer = setTimeout(() => {
        this.streamTrailingTimer = undefined;
        this.emitStreamNow();
      }, STREAM_THROTTLE_MS - elapsed);
    }
  }

  private emitStreamNow(): void {
    this.lastStreamEmitAt = Date.now();
    // visibleStreamText, not the raw buffer: the DM's turn ends with a
    // machine-read [[SUGGEST: ...]] trailer, and streaming it verbatim would
    // let the marker type itself out on screen before being stripped.
    this.cb.onStreamText(visibleStreamText(this.streamBuffer));
  }

  private cancelStreamThrottle(): void {
    if (this.streamTrailingTimer) {
      clearTimeout(this.streamTrailingTimer);
      this.streamTrailingTimer = undefined;
    }
  }

  private handleTurnComplete(rawText: string): void {
    this.cancelStreamThrottle();
    this.streamBuffer = '';
    this.cb.onStreamText('');

    // Split before anything persists or renders: the suggestions trailer must
    // never reach the story log, the transcript (and so the context brief and
    // the chronicle summarizer), or the player's screen.
    const { text, suggestions } = splitSuggestions(rawText);

    this.cb.onStoryAppend({ id: this.nextStoryId++, kind: 'dm', text });
    appendTranscript(this.state.campaign.slug, { role: 'dm', text, ts: new Date().toISOString() }, this.baseDir);
    this.cb.onSuggestions?.(suggestions);

    this.forceSave();
    this.setBusy(false);
    this.notifyIdle();

    if (!this.chronicling) {
      const entries = readTranscript(this.state.campaign.slug, this.baseDir);
      if (
        shouldSummarize(
          entries,
          this.state.chronicle.lastSummarizedIndex,
          this.summarizeThresholdChars,
          this.summarizeThresholdEntries,
        )
      ) {
        this.rotationPromise = this.runChronicleUpdate();
      }
    }
  }

  private handleError(err: DmError): void {
    this.clearPendingRollOnAbort();

    // Leave a trace on the SERVER. Previously a failed turn wrote nothing
    // anywhere: onSystemNote is a transient client event that reconnects never
    // replay, nothing reaches the transcript, and nothing reaches the process
    // log -- so a campaign whose opening turn died was undiagnosable after the
    // fact. journalctl -u dnd.service is the only record an operator has.
    console.error(
      `[dm-error] campaign="${this.state.campaign.slug}" kind=${err.kind}: ${err.message}`,
    );

    this.cb.onSystemNote(err.friendly);

    // A failure on the very first turn is the one that strands a player: the
    // story is empty, the transient note vanishes on reload, and the screen
    // just sits there with nothing to act on -- which is exactly what happened
    // to a new campaign that went 40 minutes blank until its owner typed
    // something in frustration and got a normal reply 7 seconds later. Persist
    // an entry so the log is never silently empty, and say plainly that typing
    // anything will start the scene.
    if (this.storyIsEmpty()) {
      this.cb.onStoryAppend({
        id: this.nextStoryId++,
        kind: 'system',
        text: `${err.friendly}\n\nThe opening scene never arrived. Type anything below to begin — your campaign is saved and intact.`,
      });
    }

    this.setBusy(false);
    this.notifyIdle();
  }

  /** True when the DM has never successfully narrated in this session -- i.e. the opening turn is what just failed. */
  private storyIsEmpty(): boolean {
    return this.nextStoryId === 1;
  }

  /**
   * Summarizes the un-summarized transcript tail into a new chapter, folds
   * it into the story-so-far rollup, then quietly rotates to a fresh DM
   * session. The fresh session's context brief is held as `pendingBrief`
   * rather than sent immediately -- see the file header comment.
   */
  private async runChronicleUpdate(): Promise<void> {
    this.chronicling = true;

    const entries = readTranscript(this.state.campaign.slug, this.baseDir);
    const lastSummarizedIndex = this.state.chronicle.lastSummarizedIndex;
    const chunk = entries
      .slice(lastSummarizedIndex)
      .filter((entry) => entry.role === 'player' || entry.role === 'dm');

    let output: { chapterSummary: string; storySoFar: string };
    try {
      output = await this.summarizeFn({
        chunk,
        storySoFar: this.state.chronicle.storySoFar,
        model: this.summarizerModel,
      });
    } catch {
      this.cb.onSystemNote('(chronicle update failed — will retry later)');
      this.chronicling = false;
      return;
    }

    // entries.length (the snapshot from the top of this function) is used
    // deliberately, not a fresh re-read -- anything appended to the
    // transcript while summarizeFn was in flight belongs to the NEXT
    // chronicle cycle, not this one.
    this.state.chronicle.chapters.push({
      summary: output.chapterSummary,
      endedAtExchange: entries.length,
    });
    this.state.chronicle.storySoFar = output.storySoFar;
    this.state.chronicle.lastSummarizedIndex = entries.length;
    this.forceSave();

    // Don't tear down the session mid-turn -- the player may well have kept
    // playing against the old session while the summarizer call above was in
    // the air. Wait for that to finish before rotating.
    await this.waitUntilSessionIdle();

    this.swapping = true;
    await this.session!.end();
    this.session = this.sessionFactory(this.sessionConfig!, this.sessionCallbacks!);
    this.session.start();
    this.pendingBrief = buildContextBrief(this.state, readTranscript(this.state.campaign.slug, this.baseDir));
    this.swapping = false;

    this.cb.onSystemNote('✦ Chronicle updated — the tale is preserved.');
    this.chronicling = false;

    if (this.queuedAction !== undefined) {
      const queued = this.queuedAction;
      this.queuedAction = undefined;
      this.sendToSession(queued);
    }
  }

  /** Resolves immediately if the session is idle; otherwise on the next turn-complete/error. */
  private waitUntilSessionIdle(): Promise<void> {
    if (!this.session?.busy) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private notifyIdle(): void {
    if (this.idleWaiters.length === 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      if (this.dirty) {
        saveGame(this.state, this.baseDir);
        this.dirty = false;
      }
    }, SAVE_DEBOUNCE_MS);
  }

  /** Cancels any pending debounce and saves immediately. Used at turn-end, and by the /save command. */
  forceSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    saveGame(this.state, this.baseDir);
    this.dirty = false;
  }

  /** Appends one JSON line per raw SDK message to saves/<slug>/debug.log. Never throws. */
  private appendDebugLog(msg: unknown): void {
    try {
      const dir = path.join(this.baseDir ?? path.join(process.cwd(), 'saves'), this.state.campaign.slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'debug.log'), `${JSON.stringify(msg)}\n`, 'utf8');
    } catch {
      // Best-effort only -- debug logging must never break the game.
    }
  }
}
