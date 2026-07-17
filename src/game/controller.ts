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
import type { GameState } from './state';
import { Engine } from './engine';
import { createDmTools } from '../ai/tools';
import { dmSystemPrompt, buildOpeningPrompt, buildContextBrief, buildNewHeroPrompt } from '../ai/prompts';
import { DmSession } from '../ai/dm';
import type { DmError, DmSessionCallbacks, DmSessionConfig } from '../ai/dm';
import { summarizeChunk } from '../ai/summarizer';
import { saveGame, appendTranscript, readTranscript } from './saves';
import type { TranscriptEntry } from './saves';

export interface StoryEntry {
  id: number;
  kind: 'player' | 'dm' | 'system';
  text: string;
}

export interface ControllerCallbacks {
  /** Completed entries only — never called with a partial/in-flight turn. */
  onStoryAppend: (entry: StoryEntry) => void;
  /** Full accumulated partial text for the in-flight DM turn; '' once the turn completes. */
  onStreamText: (partial: string) => void;
  onStateChange: (state: GameState) => void;
  onDiceRoll: (message: string) => void;
  onToolActivity?: (toolName: string) => void;
  onBusyChange: (busy: boolean) => void;
  /** Friendly errors, rate-limit notes, interrupt confirmations. */
  onSystemNote: (note: string) => void;
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
  /** Cheap-model override for the summarizer. Default 'haiku'. */
  summarizerModel?: string;
  /** Test seam: replaces `new DmSession(...)`. Defaults to constructing a real DmSession. */
  sessionFactory?: (config: DmSessionConfig, callbacks: DmSessionCallbacks) => DmSessionLike;
  /** Test seam: replaces the real chronicle summarizer call. */
  summarizeFn?: typeof summarizeChunk;
  /** When true, every raw SDK message is appended to saves/<slug>/debug.log. Default false. */
  debug?: boolean;
}

const SAVE_DEBOUNCE_MS = 300;
const STREAM_THROTTLE_MS = 50;
const DEFAULT_SUMMARIZE_THRESHOLD_CHARS = 24000;
const DEFAULT_SUMMARIZE_THRESHOLD_ENTRIES = 40;
const DEFAULT_SUMMARIZER_MODEL = 'haiku';

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

export class GameController {
  private readonly state: GameState;
  private readonly cb: ControllerCallbacks;
  private readonly baseDir: string | undefined;

  private readonly summarizeThresholdChars: number;
  private readonly summarizeThresholdEntries: number;
  private readonly summarizerModel: string;
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

  constructor(state: GameState, cb: ControllerCallbacks, opts?: GameControllerOptions) {
    this.state = state;
    this.cb = cb;
    this.baseDir = opts?.baseDir;
    this.summarizeThresholdChars = opts?.summarizeThresholdChars ?? DEFAULT_SUMMARIZE_THRESHOLD_CHARS;
    this.summarizeThresholdEntries = opts?.summarizeThresholdEntries ?? DEFAULT_SUMMARIZE_THRESHOLD_ENTRIES;
    this.summarizerModel = opts?.summarizerModel ?? DEFAULT_SUMMARIZER_MODEL;
    this.sessionFactory = opts?.sessionFactory ?? ((config, callbacks) => new DmSession(config, callbacks));
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

    const { server, allowedTools } = createDmTools(engine, {
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
    });

    this.sessionConfig = {
      systemPrompt: dmSystemPrompt(this.state.campaign.contentRating),
      server,
      allowedTools,
      model: this.state.campaign.modelOverride,
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
    this.setBusy(true);

    if (mode === 'new') {
      this.session.send(buildOpeningPrompt(this.state));
      return;
    }

    const transcript = readTranscript(this.state.campaign.slug, this.baseDir);
    const brief = buildContextBrief(this.state, transcript);
    if (mode === 'new-hero') {
      this.session.send(`${brief}\n\n${buildNewHeroPrompt(this.state)}`);
    } else {
      this.session.send(brief);
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
    this.setBusy(true);

    if (this.swapping) {
      // Old session already ended, the fresh one isn't up yet -- hold the
      // one slot; runChronicleUpdate() flushes it once rotation finishes.
      this.queuedAction = trimmed;
      return;
    }

    this.sendToSession(trimmed);
  }

  async interrupt(): Promise<void> {
    if (!this.session) return;
    await this.session.interrupt();
    this.cancelStreamThrottle();
    this.streamBuffer = '';
    this.cb.onStreamText('');
    this.setBusy(false);
    this.cb.onSystemNote('Interrupted.');
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
    this.cb.onStreamText(this.streamBuffer);
  }

  private cancelStreamThrottle(): void {
    if (this.streamTrailingTimer) {
      clearTimeout(this.streamTrailingTimer);
      this.streamTrailingTimer = undefined;
    }
  }

  private handleTurnComplete(text: string): void {
    this.cancelStreamThrottle();
    this.streamBuffer = '';
    this.cb.onStreamText('');

    this.cb.onStoryAppend({ id: this.nextStoryId++, kind: 'dm', text });
    appendTranscript(this.state.campaign.slug, { role: 'dm', text, ts: new Date().toISOString() }, this.baseDir);

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
    this.cb.onSystemNote(err.friendly);
    this.setBusy(false);
    this.notifyIdle();
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
