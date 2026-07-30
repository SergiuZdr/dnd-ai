// Tests for the "forever" memory system: the pure shouldSummarize threshold
// check, and the GameController's chronicle-update + session-rotation flow.
// No real SDK here -- a fake DmSessionLike + a fake summarizeFn stand in for
// the Agent SDK entirely (see scripts/smoke/memory-smoke.ts for the real-SDK proof).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GameController, shouldSummarize } from '../../src/game/controller';
import type { ControllerCallbacks, DmSessionLike } from '../../src/game/controller';
import type { GameState } from '../../src/game/state';
import type { TranscriptEntry } from '../../src/game/saves';
import { readTranscript, loadGame } from '../../src/game/saves';
import type { DmSessionCallbacks, DmSessionConfig } from '../../src/ai/dm';
import type { SummarizeInput, SummarizeOutput } from '../../src/ai/summarizer';

function tEntry(role: TranscriptEntry['role'], text: string): TranscriptEntry {
  return { role, text, ts: '2024-01-01T00:00:00.000Z' };
}

describe('shouldSummarize', () => {
  it('is false when neither threshold is crossed', () => {
    const entries = [tEntry('player', 'hi'), tEntry('dm', 'hello')];
    expect(shouldSummarize(entries, 0, 1000, 10)).toBe(false);
  });

  it('is true once the char threshold is crossed', () => {
    const entries = [tEntry('player', 'a'.repeat(50)), tEntry('dm', 'b'.repeat(60))];
    expect(shouldSummarize(entries, 0, 100, 1000)).toBe(true);
  });

  it('treats the char threshold as inclusive (>=) at the exact boundary', () => {
    const entries = [tEntry('player', 'a'.repeat(10))];
    expect(shouldSummarize(entries, 0, 10, 1000)).toBe(true);
    expect(shouldSummarize(entries, 0, 11, 1000)).toBe(false);
  });

  it('is true once the entry-count threshold is crossed (inclusive boundary)', () => {
    const entries = [tEntry('player', 'a'), tEntry('dm', 'b'), tEntry('player', 'c')];
    expect(shouldSummarize(entries, 0, 100000, 3)).toBe(true);
    expect(shouldSummarize(entries, 0, 100000, 4)).toBe(false);
  });

  it('excludes system-role entries from both the char sum and the count', () => {
    const entries = [tEntry('system', 'x'.repeat(1000)), tEntry('player', 'a'), tEntry('dm', 'b')];
    expect(shouldSummarize(entries, 0, 1000, 3)).toBe(false);
  });

  it('only counts entries strictly after lastSummarizedIndex', () => {
    const entries = [tEntry('player', 'a'.repeat(500)), tEntry('dm', 'b'.repeat(500)), tEntry('player', 'c')];
    // Once the first two (already-summarized) entries are excluded, nothing crosses threshold.
    expect(shouldSummarize(entries, 2, 100, 100)).toBe(false);
    // But counting from the start, they do.
    expect(shouldSummarize(entries, 0, 100, 100)).toBe(true);
  });
});

/** Minimal DmSessionLike fake: records sends, fires callbacks on demand via completeTurn(). */
class FakeSession implements DmSessionLike {
  sentMessages: string[] = [];
  startCount = 0;
  endCount = 0;
  private _busy = false;

  constructor(private readonly callbacks: DmSessionCallbacks) {}

  get busy(): boolean {
    return this._busy;
  }

  start(): void {
    this.startCount += 1;
  }

  send(text: string): void {
    this.sentMessages.push(text);
    this._busy = true;
  }

  async interrupt(): Promise<void> {
    this._busy = false;
  }

  async end(): Promise<void> {
    this.endCount += 1;
  }

  /** Test helper: simulate the DM finishing the in-flight turn. */
  completeTurn(text: string): void {
    this._busy = false;
    this.callbacks.onTurnComplete({ text });
  }
}

function makeState(): GameState {
  return {
    campaign: {
      slug: 'chronicle-test',
      name: 'Chronicle Test',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      contentRating: 'PG-13',
    },
    character: {
      name: 'Hero',
      className: 'Fighter',
      race: 'Human',
      background: '',
      backgroundFact: '',
      level: 1,
      xp: 0,
      hp: 12,
      maxHp: 12,
      ac: 15,
      stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
      gold: 10,
      inventory: [],
      luck: 1,
    },
    world: { theme: 'classic fantasy', location: 'Starting Village', npcs: [], quests: [], facts: [] },
    chronicle: { storySoFar: '', chapters: [], lastSummarizedIndex: 0 },
  };
}

function makeCallbacks(): ControllerCallbacks {
  return {
    onStoryAppend: vi.fn(),
    onStreamText: vi.fn(),
    onStateChange: vi.fn(),
    onDiceRoll: vi.fn(),
    onBusyChange: vi.fn(),
    onSystemNote: vi.fn(),
    onRollPrompt: vi.fn(),
    onHistoryReplay: vi.fn(),
  };
}

describe('GameController chronicle + session rotation', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-chronicle-'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('summarizes once the threshold crosses, rotates the session, and prepends the brief to the next action', async () => {
    const sessions: FakeSession[] = [];
    const sessionFactory = (config: DmSessionConfig, callbacks: DmSessionCallbacks): DmSessionLike => {
      const session = new FakeSession(callbacks);
      sessions.push(session);
      return session;
    };

    const summarizeFn = vi.fn(
      async (input: SummarizeInput): Promise<SummarizeOutput> => ({
        chapterSummary: `Chapter covering ${input.chunk.length} entries.`,
        storySoFar: 'The hero has begun a grand adventure.',
      }),
    );

    const state = makeState();
    const cb = makeCallbacks();
    const controller = new GameController(state, cb, {
      baseDir,
      summarizeThresholdEntries: 3,
      summarizeThresholdChars: 1_000_000,
      sessionFactory,
      summarizeFn,
    });

    controller.start('new');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sentMessages).toHaveLength(1); // opening prompt

    // Opening DM turn completes -> 1 transcript entry (dm). Not yet at threshold (3).
    sessions[0].completeTurn('Welcome to the village. What do you do?');
    expect(readTranscript('chronicle-test', baseDir)).toHaveLength(1);
    expect(summarizeFn).not.toHaveBeenCalled();

    // Player action -> 2 transcript entries (dm, player).
    controller.submitPlayerAction('I look around.');
    expect(sessions[0].sentMessages).toHaveLength(2);

    // DM responds -> 3 transcript entries (dm, player, dm) -> crosses the entry threshold.
    sessions[0].completeTurn('You see a quiet square.');

    // runChronicleUpdate() is fired-and-forgotten from handleTurnComplete; let its
    // microtasks (summarizeFn await, rotation) run to completion.
    await vi.waitFor(() => {
      expect(cb.onSystemNote).toHaveBeenCalledWith('✦ Chronicle updated — the tale is preserved.');
    });

    // Summarizer was invoked with exactly the 3 unsummarized entries.
    expect(summarizeFn).toHaveBeenCalledTimes(1);
    expect(summarizeFn.mock.calls[0][0].chunk).toHaveLength(3);
    expect(summarizeFn.mock.calls[0][0].storySoFar).toBe('');

    // Chronicle updated + persisted to disk.
    expect(state.chronicle.chapters).toHaveLength(1);
    expect(state.chronicle.chapters[0].endedAtExchange).toBe(3);
    expect(state.chronicle.storySoFar).toBe('The hero has begun a grand adventure.');
    expect(state.chronicle.lastSummarizedIndex).toBe(3);
    const saved = loadGame('chronicle-test', baseDir);
    expect(saved.chronicle).toEqual(state.chronicle);

    // Session rotated: factory called twice, old session ended, new one started.
    expect(sessions).toHaveLength(2);
    expect(sessions[0].endCount).toBe(1);
    expect(sessions[1].startCount).toBe(1);

    // Next action goes to the NEW session, prefixed with the brief; the player's
    // text sits before the wire-only mechanics reminder that ends the message.
    controller.submitPlayerAction('I continue on my way.');
    expect(sessions[1].sentMessages).toHaveLength(1);
    const sentToNewSession = sessions[1].sentMessages[0];
    expect(sentToNewSession.startsWith('[CAMPAIGN BRIEFING')).toBe(true);
    expect(sentToNewSession).toContain('I continue on my way.');
    expect(sentToNewSession.endsWith('</system-reminder>')).toBe(true);
    expect(sentToNewSession).toContain('[The player now acts:]\nI continue on my way.');

    // Story log + transcript only ever recorded the player's own text, never the brief.
    const playerStoryEntries = vi
      .mocked(cb.onStoryAppend)
      .mock.calls.map(([entry]) => entry)
      .filter((entry) => entry.kind === 'player');
    expect(playerStoryEntries.map((entry) => entry.text)).toEqual(['I look around.', 'I continue on my way.']);
    for (const entry of playerStoryEntries) {
      expect(entry.text).not.toContain('CAMPAIGN BRIEFING');
    }
    const playerTranscriptEntries = readTranscript('chronicle-test', baseDir).filter(
      (entry) => entry.role === 'player',
    );
    expect(playerTranscriptEntries.map((entry) => entry.text)).toEqual([
      'I look around.',
      'I continue on my way.',
    ]);
  });

  it('on summarizer failure, leaves lastSummarizedIndex unchanged, emits a retry note, and retries later', async () => {
    const sessions: FakeSession[] = [];
    const sessionFactory = (config: DmSessionConfig, callbacks: DmSessionCallbacks): DmSessionLike => {
      const session = new FakeSession(callbacks);
      sessions.push(session);
      return session;
    };
    const summarizeFn = vi.fn(async (): Promise<SummarizeOutput> => {
      throw new Error('summarizer boom');
    });

    const state = makeState();
    const cb = makeCallbacks();
    const controller = new GameController(state, cb, {
      baseDir,
      summarizeThresholdEntries: 1,
      summarizeThresholdChars: 1_000_000,
      sessionFactory,
      summarizeFn,
    });

    controller.start('new');
    sessions[0].completeTurn('Welcome. What do you do?');

    await vi.waitFor(() => {
      expect(cb.onSystemNote).toHaveBeenCalledWith('(chronicle update failed — will retry later)');
    });

    expect(state.chronicle.lastSummarizedIndex).toBe(0);
    expect(state.chronicle.chapters).toHaveLength(0);
    // No rotation happened.
    expect(sessions).toHaveLength(1);
    expect(sessions[0].endCount).toBe(0);

    // A later completed turn naturally retries, since the threshold is still crossed.
    controller.submitPlayerAction('I wait.');
    sessions[0].completeTurn('Nothing happens... yet.');
    await vi.waitFor(() => {
      expect(summarizeFn).toHaveBeenCalledTimes(2);
    });
  });

  it('waits for an in-flight turn on the old session before rotating (no premature end())', async () => {
    const sessions: FakeSession[] = [];
    const sessionFactory = (config: DmSessionConfig, callbacks: DmSessionCallbacks): DmSessionLike => {
      const session = new FakeSession(callbacks);
      sessions.push(session);
      return session;
    };

    let resolveSummarize: ((output: SummarizeOutput) => void) | undefined;
    const summarizeFn = vi.fn(
      () =>
        new Promise<SummarizeOutput>((resolve) => {
          resolveSummarize = resolve;
        }),
    );

    const state = makeState();
    const cb = makeCallbacks();
    const controller = new GameController(state, cb, {
      baseDir,
      summarizeThresholdEntries: 1,
      summarizeThresholdChars: 1_000_000,
      sessionFactory,
      summarizeFn,
    });

    controller.start('new');
    sessions[0].completeTurn('Welcome. What do you do?'); // crosses threshold(1) -> chronicle update begins

    await vi.waitFor(() => expect(summarizeFn).toHaveBeenCalledTimes(1));

    // Player keeps playing against the OLD session while the summarizer call is in flight.
    controller.submitPlayerAction('I check my pockets.');
    expect(sessions[0].sentMessages).toHaveLength(2); // opening + this action, still on session 0
    expect(sessions).toHaveLength(1); // no rotation yet -- summarizer hasn't resolved

    // Resolve the summarizer. Rotation must still wait: the player's second turn is in flight.
    resolveSummarize!({ chapterSummary: 'A chapter.', storySoFar: 'Rollup.' });
    await vi.waitFor(() => expect(state.chronicle.chapters).toHaveLength(1)); // chronicle mutated...
    expect(sessions[0].endCount).toBe(0); // ...but the old session must not end mid-turn

    // The in-flight turn completes -- rotation proceeds only now.
    sessions[0].completeTurn('You find a few coppers.');

    await vi.waitFor(() => {
      expect(cb.onSystemNote).toHaveBeenCalledWith('✦ Chronicle updated — the tale is preserved.');
    });
    expect(sessions).toHaveLength(2);
    expect(sessions[0].endCount).toBe(1);
  });

  it('queues a player action submitted mid-swap and flushes it (brief-prefixed) once the new session is up', async () => {
    const sessions: FakeSession[] = [];
    let controllerRef!: GameController;
    const sessionFactory = (config: DmSessionConfig, callbacks: DmSessionCallbacks): DmSessionLike => {
      const session = new FakeSession(callbacks);
      sessions.push(session);
      if (sessions.length === 1) {
        // Simulate the player racing in a submission during the narrow window
        // where the old session has just ended but the new one isn't up yet.
        const realEnd = session.end.bind(session);
        session.end = async () => {
          await realEnd();
          controllerRef.submitPlayerAction('I act during the swap.');
        };
      }
      return session;
    };

    const summarizeFn = vi.fn(
      async (): Promise<SummarizeOutput> => ({ chapterSummary: 'A chapter.', storySoFar: 'Rollup.' }),
    );

    const state = makeState();
    const cb = makeCallbacks();
    const controller = new GameController(state, cb, {
      baseDir,
      summarizeThresholdEntries: 1,
      summarizeThresholdChars: 1_000_000,
      sessionFactory,
      summarizeFn,
    });
    controllerRef = controller;

    controller.start('new');
    sessions[0].completeTurn('Welcome. What do you do?');

    await vi.waitFor(() => {
      expect(cb.onSystemNote).toHaveBeenCalledWith('✦ Chronicle updated — the tale is preserved.');
    });

    expect(sessions).toHaveLength(2);
    // The mid-swap action was queued and flushed to the NEW session once it came up,
    // prefixed with the brief exactly like a normal post-rotation action.
    expect(sessions[1].sentMessages).toHaveLength(1);
    expect(sessions[1].sentMessages[0].startsWith('[CAMPAIGN BRIEFING')).toBe(true);
    expect(sessions[1].sentMessages[0]).toContain('I act during the swap.');
    expect(sessions[1].sentMessages[0].endsWith('</system-reminder>')).toBe(true);

    // And it was still recorded as ordinary player story/transcript text.
    const playerStoryEntries = vi
      .mocked(cb.onStoryAppend)
      .mock.calls.map(([entry]) => entry)
      .filter((entry) => entry.kind === 'player');
    expect(playerStoryEntries.map((entry) => entry.text)).toContain('I act during the swap.');
  });

  it('shutdown() awaits an in-flight chronicle rotation instead of racing it', async () => {
    const sessions: FakeSession[] = [];
    const sessionFactory = (config: DmSessionConfig, callbacks: DmSessionCallbacks): DmSessionLike => {
      const session = new FakeSession(callbacks);
      sessions.push(session);
      return session;
    };

    let resolveSummarize: ((output: SummarizeOutput) => void) | undefined;
    const summarizeFn = vi.fn(
      () =>
        new Promise<SummarizeOutput>((resolve) => {
          resolveSummarize = resolve;
        }),
    );

    const state = makeState();
    const cb = makeCallbacks();
    const controller = new GameController(state, cb, {
      baseDir,
      summarizeThresholdEntries: 1,
      summarizeThresholdChars: 1_000_000,
      sessionFactory,
      summarizeFn,
    });

    controller.start('new');
    sessions[0].completeTurn('Welcome. What do you do?'); // crosses threshold(1) -> chronicle update begins

    await vi.waitFor(() => expect(summarizeFn).toHaveBeenCalledTimes(1));

    // Player quits (e.g. /quit) right as the chronicle update is stuck awaiting the
    // summarizer -- shutdown() must not touch session 0 until rotation is fully done.
    const shutdownPromise = controller.shutdown();

    await Promise.resolve();
    expect(sessions[0].endCount).toBe(0);
    expect(sessions).toHaveLength(1);

    // Resolve the summarizer -> rotation proceeds: ends session 0, starts session 1.
    resolveSummarize!({ chapterSummary: 'A chapter.', storySoFar: 'Rollup.' });
    await shutdownPromise;

    // Rotation ran to completion (session 0 ended exactly once, session 1 started) before
    // shutdown() ended "the" session -- and shutdown ended the ROTATED-TO session, not
    // session 0 a second time.
    expect(sessions).toHaveLength(2);
    expect(sessions[0].endCount).toBe(1);
    expect(sessions[1].startCount).toBe(1);
    expect(sessions[1].endCount).toBe(1);
  });
});
