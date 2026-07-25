// The pure heart of phone/web play: owns the mirrored state of the single
// active game session and turns ControllerCallbacks into Server-Sent-Event
// objects. Fully unit-testable with a fake GameController -- this file never
// touches the network or the filesystem itself; server.ts wires it to real
// HTTP, exactly the way App.tsx wires ControllerCallbacks to React state for
// the TUI. GameController itself is untouched: this is just another consumer
// of the same callback surface ink already uses.
import type { GameState } from '../game/state';
import type { ControllerCallbacks, PendingRollRequest, StoryEntry } from '../game/controller';

/** The subset of GameState the client needs -- character+world only. Campaign/chronicle internals stay server-side (chronicle is reachable via /journal); this also keeps the wire payload small on a phone connection. */
export interface SanitizedState {
  character: GameState['character'];
  world: GameState['world'];
}

export interface SseEvent {
  event: string;
  data: unknown;
}

export interface CampaignInfo {
  slug: string;
  name: string;
}

/** Sent to every newly-connected SSE client so its render is a full, idempotent snapshot -- a phone's EventSource can reconnect at any point (screen lock, network blip), and it must never assume continuity with whatever it saw before. */
export interface HelloSnapshot {
  campaign: CampaignInfo | null;
  entries: StoryEntry[];
  state: SanitizedState | null;
  busy: boolean;
  pendingRoll: PendingRollRequest | null;
  diceMessage: string;
}

export type SseSink = (event: SseEvent) => void;

/** Deep-cloned (structuredClone) so a captured snapshot is a true point-in-time copy, never entangled with the live GameState object the Engine keeps mutating in place. */
function sanitizeState(state: GameState): SanitizedState {
  return structuredClone({ character: state.character, world: state.world });
}

/**
 * Owns ONE game session's mirrored state at a time, mapping
 * ControllerCallbacks 1:1 onto SSE broadcasts to every connected client.
 * Keeps just enough in memory (entries, latest state, busy, pending roll,
 * last dice message) to answer a fresh connection's `hello` with a complete
 * snapshot -- see HelloSnapshot's doc comment for why that matters on a
 * phone specifically.
 */
export class GameBridge {
  private campaign: CampaignInfo | null = null;
  private entries: StoryEntry[] = [];
  private state: GameState | null = null;
  private busy = false;
  private pendingRoll: PendingRollRequest | null = null;
  private diceMessage = '';
  /** Counts DOWN (like App.tsx's systemIdRef for the TUI) so locally-synthesized entries (appendSystemNote) never collide with the controller's own positive, incrementing StoryEntry ids. */
  private systemIdCounter = 0;

  private readonly sinks = new Set<SseSink>();

  /** True once attach() has been called and detach() hasn't since -- server.ts's single source of truth for "is a session active" (the 409 check on /api/continue). */
  get hasSession(): boolean {
    return this.campaign !== null;
  }

  /**
   * Wires this bridge as a fresh session's ControllerCallbacks -- call once,
   * right before `new GameController(state, callbacks, opts)`. Resets all
   * mirrored state first (defensive: server.ts's 409 guard should already
   * prevent double-attach, but a fresh session must never inherit a stale
   * entries/state from whatever came before).
   */
  attach(campaign: CampaignInfo): ControllerCallbacks {
    this.campaign = campaign;
    this.entries = [];
    this.state = null;
    this.busy = false;
    this.pendingRoll = null;
    this.diceMessage = '';
    this.systemIdCounter = 0;

    return {
      onStoryAppend: (entry) => {
        this.entries.push(entry);
        this.broadcast({ event: 'story', data: entry });
      },
      onStreamText: (text) => {
        this.broadcast({ event: 'stream', data: { text } });
      },
      onStateChange: (state) => {
        this.state = state;
        this.broadcast({ event: 'state', data: sanitizeState(state) });
      },
      onDiceRoll: (message) => {
        this.diceMessage = message;
        this.broadcast({ event: 'dice', data: { message } });
      },
      onBusyChange: (busy) => {
        this.busy = busy;
        this.broadcast({ event: 'busy', data: { busy } });
      },
      // Friendly errors / rate-limit notes / interrupt confirmations / chronicle-
      // rotation notices -- transient session-level notices, not story content.
      // Broadcast as their own 'note' event (not folded into `entries`/'story'):
      // the client renders these as it sees fit (inline in its feed and/or a
      // toast) but a fresh reconnect's hello() intentionally does not replay
      // past ones, same as these are never written to the transcript either.
      onSystemNote: (text) => {
        this.broadcast({ event: 'note', data: { text } });
      },
      onRollPrompt: (request) => {
        this.pendingRoll = request;
        this.broadcast({ event: 'roll', data: request });
      },
      onHistoryReplay: (replayed) => {
        this.entries.push(...replayed);
        this.broadcast({ event: 'replay', data: { entries: replayed } });
      },
      // Transient, like onSystemNote's 'note' event -- never stored, so
      // hello() never replays a stale toast at a reconnecting client.
      onLedgerGain: (delta) => {
        this.broadcast({ event: 'ledger', data: delta });
      },
    };
  }

  /** Ends the session from the bridge's point of view (server.ts calls this after controller.shutdown() on /api/end). Back to "no campaign" for hello() purposes; does NOT disconnect SSE clients -- they simply see hasSession go false and the next /api/continue's hello re-snapshot them. */
  detach(): void {
    this.campaign = null;
    this.entries = [];
    this.state = null;
    this.busy = false;
    this.pendingRoll = null;
    this.diceMessage = '';
    this.systemIdCounter = 0;
  }

  /**
   * Appends a LOCAL system-kind story entry the controller never sees (e.g.
   * /help, /sheet, /journal, /save's "Saved." confirmation) -- mirrors
   * App.tsx's appendSystemEntry for the TUI. Uses NEGATIVE, decrementing ids
   * so these never collide with the controller's own positive, incrementing
   * StoryEntry ids (same trick App.tsx's systemIdRef uses). Broadcasts as a
   * normal 'story' event so it becomes part of the persistent feed (and a
   * reconnecting client's `hello()` sees it too) -- distinct from the
   * controller's own onSystemNote, which broadcasts the separate 'note'
   * event and is NOT persisted here (see that handler's comment below).
   */
  appendSystemEntry(text: string): void {
    this.systemIdCounter -= 1;
    const entry: StoryEntry = { id: this.systemIdCounter, kind: 'system', text };
    this.entries.push(entry);
    this.broadcast({ event: 'story', data: entry });
  }

  /** The full snapshot for a brand-new SSE connection. */
  hello(): HelloSnapshot {
    return {
      campaign: this.campaign,
      // Shallow copy -- entries only ever grows by push(), but a caller
      // holding an older hello() result should see the list AS IT WAS then,
      // not silently grow because it aliased the live array (same
      // point-in-time reasoning as sanitizeState's structuredClone above).
      entries: [...this.entries],
      state: this.state ? sanitizeState(this.state) : null,
      busy: this.busy,
      pendingRoll: this.pendingRoll,
      diceMessage: this.diceMessage,
    };
  }

  /**
   * Broadcasts a fresh `hello` snapshot to every currently-connected client --
   * server.ts calls this right after controller.start() on continue/new/
   * retire so already-open tabs (on this device or another) re-snapshot onto
   * the new/loaded session instead of only learning about it on their next
   * reconnect. A brand-new SSE connection still gets its own hello from
   * handleEvents() unchanged; this is purely for sessions already listening.
   */
  broadcastHello(): void {
    this.broadcast({ event: 'hello', data: this.hello() });
  }

  /** Registers a new SSE client sink; returns an unsubscribe function (server.ts calls it on `req.on('close', ...)`). */
  subscribe(sink: SseSink): () => void {
    this.sinks.add(sink);
    return () => {
      this.sinks.delete(sink);
    };
  }

  /** How many SSE clients are currently connected -- exposed for tests/diagnostics only, not used for any behavior decision. */
  get clientCount(): number {
    return this.sinks.size;
  }

  private broadcast(event: SseEvent): void {
    for (const sink of this.sinks) sink(event);
  }
}
