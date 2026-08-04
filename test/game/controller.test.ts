// Controller smoke WITHOUT AI: import-safety + guard-logic only. Most tests
// here never call start() (that would spin up a real DmSession/Agent SDK
// query) -- they only prove construction is side-effect-free and that the
// busy/blank guards on submitPlayerAction hold before any session exists.
// The "history replay on resume" block below is the one exception: it DOES
// call start(), but always with a sessionFactory test seam (a fake
// DmSessionLike, same pattern chronicle.test.ts uses), so no real SDK query
// is ever constructed.

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GameController } from '../../src/game/controller';
import type { ControllerCallbacks, DmSessionLike, StoryEntry } from '../../src/game/controller';
import type { GameState } from '../../src/game/state';
import { loadGame, appendTranscript, readTranscript } from '../../src/game/saves';
import { buildContextBrief } from '../../src/ai/prompts';
import type { DmSessionCallbacks } from '../../src/ai/dm';
import { Engine } from '../../src/game/engine';
import type { EngineResult } from '../../src/game/engine';
import { DmError } from '../../src/ai/dm';

function makeState(): GameState {
  return {
    campaign: {
      slug: 'controller-test',
      name: 'Controller Test',
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
    world: {
      theme: 'classic fantasy',
      location: 'Starting Village',
      npcs: [],
      quests: [],
      facts: [],
    },
    chronicle: {
      storySoFar: '',
      chapters: [],
      lastSummarizedIndex: 0,
    },
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

describe('GameController', () => {
  it('constructs without any side effects (no AI session, no engine, no timers)', () => {
    const cb = makeCallbacks();
    expect(() => new GameController(makeState(), cb)).not.toThrow();
    expect(cb.onStoryAppend).not.toHaveBeenCalled();
    expect(cb.onBusyChange).not.toHaveBeenCalled();
    expect(cb.onStateChange).not.toHaveBeenCalled();
    expect(cb.onSystemNote).not.toHaveBeenCalled();
  });

  it('submitPlayerAction ignores blank/whitespace-only input', () => {
    const cb = makeCallbacks();
    const controller = new GameController(makeState(), cb);
    expect(() => controller.submitPlayerAction('')).not.toThrow();
    expect(() => controller.submitPlayerAction('   ')).not.toThrow();
    expect(cb.onStoryAppend).not.toHaveBeenCalled();
    expect(cb.onBusyChange).not.toHaveBeenCalled();
  });

  it('submitPlayerAction is a no-op before start() even with valid text', () => {
    const cb = makeCallbacks();
    const controller = new GameController(makeState(), cb);
    expect(() => controller.submitPlayerAction('I open the door.')).not.toThrow();
    expect(cb.onStoryAppend).not.toHaveBeenCalled();
  });

  it('submitPlayerAction ignores input while busy', () => {
    const cb = makeCallbacks();
    const controller = new GameController(makeState(), cb);
    // Force the internal busy flag on without going through start() (which
    // would require a live DmSession/AI call) -- this gate is guard logic only.
    (controller as unknown as { busy: boolean }).busy = true;
    controller.submitPlayerAction('I attack the goblin!');
    expect(cb.onStoryAppend).not.toHaveBeenCalled();
    // onBusyChange should only ever have been invoked by us, never by the controller here.
    expect(cb.onBusyChange).not.toHaveBeenCalled();
  });

  it('interrupt() before start() resolves without throwing and touches no callback', async () => {
    const cb = makeCallbacks();
    const controller = new GameController(makeState(), cb);
    await expect(controller.interrupt()).resolves.toBeUndefined();
    expect(cb.onSystemNote).not.toHaveBeenCalled();
    expect(cb.onBusyChange).not.toHaveBeenCalled();
  });

  it('shutdown() before start() resolves without throwing', async () => {
    const cb = makeCallbacks();
    const controller = new GameController(makeState(), cb);
    await expect(controller.shutdown()).resolves.toBeUndefined();
  });

  it('forceSave() is public and writes an immediately-loadable save, even before start()', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-forcesave-'));
    try {
      const state = makeState();
      const cb = makeCallbacks();
      const controller = new GameController(state, cb, { baseDir });

      controller.forceSave();

      const loaded = loadGame(state.campaign.slug, baseDir);
      expect(loaded.character.name).toBe(state.character.name);
      expect(loaded.campaign.slug).toBe(state.campaign.slug);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

/**
 * These drive the private pendingRoll/engine fields directly via a cast,
 * mirroring the existing `busy` guard tests above -- exercising the real
 * roll_dice tool handler would require a live Agent SDK query, which this
 * suite deliberately never spins up. That still leaves the orchestration
 * logic itself (confirmRoll/resolvePendingRoll/abort-clearing) fully covered.
 */
describe('GameController interactive player dice rolls', () => {
  function makeFakeSession(): DmSessionLike {
    return { start: () => {}, send: () => {}, interrupt: async () => {}, end: async () => {}, busy: false };
  }

  function primeEngine(controller: GameController, state: GameState): Engine {
    const engine = new Engine(state);
    (controller as unknown as { engine: Engine }).engine = engine;
    return engine;
  }

  function primePendingRoll(
    controller: GameController,
    request: { expr: string; mode?: 'normal' | 'advantage' | 'disadvantage'; reason: string; dc?: number },
  ): EngineResult[] {
    const resolved: EngineResult[] = [];
    (controller as unknown as { pendingRoll: unknown }).pendingRoll = {
      request,
      resolve: (r: EngineResult) => resolved.push(r),
    };
    return resolved;
  }

  it('confirmRoll resolves immediately (canReroll false) when the request has no dc', () => {
    const state = makeState();
    const cb = makeCallbacks();
    const controller = new GameController(state, cb);
    primeEngine(controller, state);
    const resolved = primePendingRoll(controller, { expr: 'd20', reason: 'a plain check' });

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.65); // d20 -> face 14
    let reveal;
    try {
      reveal = controller.confirmRoll();
    } finally {
      randomSpy.mockRestore();
    }

    expect(reveal?.canReroll).toBe(false);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].ok).toBe(true);
    expect(cb.onRollPrompt).toHaveBeenLastCalledWith(null);

    // Structured fields: no dc means no success verdict, but the roll detail is always there.
    expect(reveal?.expr).toBe('d20');
    expect(reveal?.reason).toBe('a plain check');
    expect(reveal?.first).toEqual({ text: '[14]', total: 14 });
    expect(reveal?.keptTotal).toBe(14);
    expect(reveal?.dc).toBeUndefined();
    expect(reveal?.success).toBeUndefined();
    expect(reveal?.reroll).toBeUndefined();
  });

  it('confirmRoll offers a luck reroll on a failed dc when luck > 0, without resolving yet', () => {
    const state = makeState();
    state.character.luck = 1;
    const cb = makeCallbacks();
    const controller = new GameController(state, cb);
    primeEngine(controller, state);
    const resolved = primePendingRoll(controller, { expr: 'd20', reason: 'a hard check', dc: 15 });

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0); // d20 -> face 1, guaranteed to fail dc 15
    let reveal;
    try {
      reveal = controller.confirmRoll();
      expect(reveal?.canReroll).toBe(true);
      expect(reveal?.luck).toBe(1);
      expect(reveal?.message).toContain('✗ failure');
    } finally {
      randomSpy.mockRestore();
    }
    // Not resolved yet -- the UI still owes a resolvePendingRoll() call.
    expect(resolved).toHaveLength(0);
    expect(cb.onRollPrompt).not.toHaveBeenLastCalledWith(null);

    // Structured fields: dc known and failed -- success is explicitly false, not just falsy/undefined.
    expect(reveal?.dc).toBe(15);
    expect(reveal?.success).toBe(false);
    expect(reveal?.first).toEqual({ text: '[1]', total: 1 });
    expect(reveal?.keptTotal).toBe(1);
    expect(reveal?.reroll).toBeUndefined();
  });

  it('confirmRoll does not offer a reroll when luck is 0, even on a failed dc', () => {
    const state = makeState();
    state.character.luck = 0;
    const cb = makeCallbacks();
    const controller = new GameController(state, cb);
    primeEngine(controller, state);
    const resolved = primePendingRoll(controller, { expr: 'd20', reason: 'a hard check', dc: 15 });

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const reveal = controller.confirmRoll();
      expect(reveal?.canReroll).toBe(false);
    } finally {
      randomSpy.mockRestore();
    }
    expect(resolved).toHaveLength(1); // resolved immediately since there's nothing to wait for
  });

  it('resolvePendingRoll(false) accepts the original roll as-is and returns the same structured fields confirmRoll gave', () => {
    const state = makeState();
    state.character.luck = 2;
    const cb = makeCallbacks();
    const controller = new GameController(state, cb);
    primeEngine(controller, state);
    const resolved = primePendingRoll(controller, { expr: 'd20', reason: 'a hard check', dc: 15 });

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0); // face 1 -> fails dc 15
    try {
      controller.confirmRoll();
    } finally {
      randomSpy.mockRestore();
    }
    const final = controller.resolvePendingRoll(false);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].ok).toBe(true);
    expect(state.character.luck).toBe(2); // untouched -- luck only spends on useLuck: true

    expect(final?.canReroll).toBe(false);
    expect(final?.dc).toBe(15);
    expect(final?.success).toBe(false);
    expect(final?.first).toEqual({ text: '[1]', total: 1 });
    expect(final?.keptTotal).toBe(1);
    expect(final?.reroll).toBeUndefined();
  });

  it('resolvePendingRoll(true) spends 1 luck, rerolls, keeps the better total, and returns both rolls structured', () => {
    const state = makeState();
    state.character.luck = 2;
    const cb = makeCallbacks();
    const controller = new GameController(state, cb);
    primeEngine(controller, state);
    const resolved = primePendingRoll(controller, { expr: 'd20', reason: 'a hard check', dc: 15 });

    const randomSpy = vi.spyOn(Math, 'random');
    randomSpy.mockReturnValueOnce(0); // first roll: face 1 -> fails dc 15
    try {
      controller.confirmRoll();
    } finally {
      randomSpy.mockRestore();
    }
    const secondSpy = vi.spyOn(Math, 'random').mockReturnValue(0.99); // reroll: face 20 -> succeeds
    let final;
    try {
      final = controller.resolvePendingRoll(true);
    } finally {
      secondSpy.mockRestore();
    }

    expect(state.character.luck).toBe(1); // spent exactly 1
    expect(resolved).toHaveLength(1);
    expect(resolved[0].ok).toBe(true);
    if (resolved[0].ok) {
      expect(resolved[0].message).toContain('luck spent');
      expect(resolved[0].message).toContain('✓ success');
    }

    // Structured "both totals" case: first is the original (failed) roll,
    // reroll is the luck-funded one, keptTotal picks the better of the two.
    expect(final?.first).toEqual({ text: '[1]', total: 1 });
    expect(final?.reroll).toEqual({ text: '[20]', total: 20 });
    expect(final?.keptTotal).toBe(20);
    expect(final?.dc).toBe(15);
    expect(final?.success).toBe(true);
    expect(final?.canReroll).toBe(false);
    expect(final?.luck).toBe(1);
  });

  it('resolvePendingRoll(true) reflects the ORIGINAL roll as kept when the reroll comes up worse', () => {
    const state = makeState();
    state.character.luck = 1;
    const cb = makeCallbacks();
    const controller = new GameController(state, cb);
    primeEngine(controller, state);
    primePendingRoll(controller, { expr: 'd20', reason: 'a check', dc: 15 });

    const firstSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5); // face 11 -- fails dc 15
    try {
      controller.confirmRoll();
    } finally {
      firstSpy.mockRestore();
    }
    const secondSpy = vi.spyOn(Math, 'random').mockReturnValue(0); // reroll: face 1, worse
    let final;
    try {
      final = controller.resolvePendingRoll(true);
    } finally {
      secondSpy.mockRestore();
    }

    expect(final?.first).toEqual({ text: '[11]', total: 11 });
    expect(final?.reroll).toEqual({ text: '[1]', total: 1 });
    expect(final?.keptTotal).toBe(11); // the original, better roll -- not the reroll
    expect(final?.success).toBe(false); // still fails dc 15 even with the better (11) total kept
  });

  it('interrupt() clears a pending roll without ever resolving it, and re-enables input', async () => {
    const cb = makeCallbacks();
    const controller = new GameController(makeState(), cb);
    (controller as unknown as { session: DmSessionLike }).session = makeFakeSession();
    const resolved = primePendingRoll(controller, { expr: 'd20', reason: 'test' });

    await controller.interrupt();

    expect(cb.onRollPrompt).toHaveBeenCalledWith(null);
    expect(resolved).toHaveLength(0); // abandoned, not completed
    expect(cb.onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('a DM session error clears a pending roll without ever resolving it, and re-enables input', () => {
    const cb = makeCallbacks();
    const controller = new GameController(makeState(), cb);
    const resolved = primePendingRoll(controller, { expr: 'd20', reason: 'test' });

    (controller as unknown as { handleError: (err: DmError) => void }).handleError(
      new DmError('unknown', 'boom', 'The weave falters.'),
    );

    expect(cb.onRollPrompt).toHaveBeenCalledWith(null);
    expect(resolved).toHaveLength(0);
    expect(cb.onSystemNote).toHaveBeenCalledWith('The weave falters.');
    expect(cb.onBusyChange).toHaveBeenLastCalledWith(false);
  });

  // A new campaign whose opening turn failed left NOTHING anywhere: the
  // transient note vanishes on reload, nothing reaches the transcript, and
  // nothing reached the process log -- one sat blank for 40 minutes until its
  // owner typed something in frustration and got a normal reply 7 seconds
  // later, and afterwards there was no record to diagnose it from.
  describe('a failure on the very first turn', () => {
    it('persists a story entry telling the player how to recover', () => {
      const cb = makeCallbacks();
      const controller = new GameController(makeState(), cb);

      (controller as unknown as { handleError: (err: DmError) => void }).handleError(
        new DmError('rate_limit', 'HTTP 429', 'The weave is exhausted.'),
      );

      const appended = (cb.onStoryAppend as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
      expect(appended).toHaveLength(1);
      expect(appended[0].kind).toBe('system');
      expect(appended[0].text).toContain('The weave is exhausted.');
      expect(appended[0].text).toMatch(/Type anything below to begin/);
    });

    it('writes the failure to the server log so it can be diagnosed afterwards', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const controller = new GameController(makeState(), makeCallbacks());
        (controller as unknown as { handleError: (err: DmError) => void }).handleError(
          new DmError('rate_limit', 'HTTP 429 too many requests', 'The weave is exhausted.'),
        );
        expect(spy).toHaveBeenCalledTimes(1);
        const line = String(spy.mock.calls[0][0]);
        expect(line).toContain('[dm-error]');
        expect(line).toContain('rate_limit');
        expect(line).toContain('HTTP 429 too many requests');
      } finally {
        spy.mockRestore();
      }
    });

    // Mid-campaign failures used to write nothing durable, which cost the
    // player twice: the error vanished on reload (leaving their action sitting
    // there unanswered and unexplained), and start('resume') kept reading that
    // trailing player line as "the DM never replied" and re-sending it -- so
    // every reopen silently spent another turn of a 50/day free quota on a turn
    // that had already failed. Both now get a persisted note, worded for where
    // it happened.
    it('records a failure mid-campaign too, worded for a turn that did not go through', () => {
      const cb = makeCallbacks();
      const controller = new GameController(makeState(), cb);
      // Any successful narration first -> this is no longer the opening turn.
      (controller as unknown as { nextStoryId: number }).nextStoryId = 5;

      (controller as unknown as { handleError: (err: DmError) => void }).handleError(
        new DmError('unknown', 'boom', 'The weave falters.'),
      );

      expect(cb.onSystemNote).toHaveBeenCalledWith('The weave falters.');
      const appended = (cb.onStoryAppend as any).mock.calls[0][0];
      expect(appended.kind).toBe('system');
      expect(appended.text).toContain('The weave falters.');
      expect(appended.text).toMatch(/did not go through/i);
      expect(appended.text).not.toMatch(/opening scene/i); // that wording is for the empty-story case
    });
  });
});

/**
 * Bug fix: resuming a campaign always started with a BLANK story log and
 * handed the DM's brand-new (memory-less) session its own last narration
 * plus "resume... end with What do you do?", inviting it to re-narrate (and,
 * per dm.ts's appendTurnText fix, sometimes glue) the scene the player
 * already read. onHistoryReplay lets the UI show the player's own actual
 * prior scene instead of relying on the DM to reproduce it.
 */
describe('GameController history replay on resume', () => {
  /** Records every send() call (and its relative order against onHistoryReplay, via the shared `calls` array passed in). */
  class RecordingSession implements DmSessionLike {
    sentMessages: string[] = [];
    busy = false;
    constructor(private readonly calls: string[]) {}
    start(): void {}
    send(text: string): void {
      this.calls.push('send');
      this.sentMessages.push(text);
    }
    async interrupt(): Promise<void> {}
    async end(): Promise<void> {}
  }

  it('replays only the un-summarized tail (transcript.slice(lastSummarizedIndex)), mapped role->kind, and does NOT send to the session (DM-terminated tail)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-replay-'));
    try {
      const state = makeState();
      state.chronicle.lastSummarizedIndex = 1; // the first entry below is already summarized away
      appendTranscript(state.campaign.slug, { role: 'dm', text: 'Welcome. What do you do?', ts: 't0' }, baseDir);
      appendTranscript(state.campaign.slug, { role: 'player', text: 'I look around.', ts: 't1' }, baseDir);
      appendTranscript(state.campaign.slug, { role: 'dm', text: 'You see a quiet square.', ts: 't2' }, baseDir);

      const calls: string[] = [];
      const cb = makeCallbacks();
      vi.mocked(cb.onHistoryReplay).mockImplementation(() => calls.push('replay'));
      const sessionFactory = () => new RecordingSession(calls);

      const controller = new GameController(state, cb, { baseDir, sessionFactory });
      controller.start('resume');

      expect(cb.onHistoryReplay).toHaveBeenCalledTimes(1);
      const replayed = vi.mocked(cb.onHistoryReplay).mock.calls[0][0];
      expect(replayed.map((e) => ({ kind: e.kind, text: e.text }))).toEqual([
        { kind: 'player', text: 'I look around.' },
        { kind: 'dm', text: 'You see a quiet square.' },
      ]);
      // The already-summarized first entry (index 0) is NOT replayed.
      expect(replayed.some((e) => e.text === 'Welcome. What do you do?')).toBe(false);
      // The tail ends on a DM line -- the player already saw this exact scene,
      // so resume must NOT generate a fresh "next second" DM turn on top of it.
      expect(calls).toEqual(['replay']);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('assigns replayed entries sequential ids that a subsequent live submitPlayerAction append never collides with', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-replay-ids-'));
    try {
      const state = makeState();
      appendTranscript(state.campaign.slug, { role: 'player', text: 'action one', ts: 't0' }, baseDir);
      appendTranscript(state.campaign.slug, { role: 'dm', text: 'narration one', ts: 't1' }, baseDir);

      const cb = makeCallbacks();
      const controller = new GameController(state, cb, {
        baseDir,
        sessionFactory: () => new RecordingSession([]),
      });
      controller.start('resume');

      const replayed = vi.mocked(cb.onHistoryReplay).mock.calls[0][0];
      const replayedIds = replayed.map((e) => e.id);
      expect(new Set(replayedIds).size).toBe(replayedIds.length); // no duplicate ids among the replay itself

      // This tail ends on a DM line, so start('resume') already leaves the
      // controller idle (busy=false) -- see the dedicated resume/busy tests
      // below. Asserting that isn't the point of this test, so no manual
      // busy override is needed before exercising submitPlayerAction's id
      // assignment.
      controller.submitPlayerAction('I check my pockets.');

      const liveAppended = vi.mocked(cb.onStoryAppend).mock.calls.map(([entry]) => entry);
      expect(liveAppended).toHaveLength(1); // the replay went through onHistoryReplay, not onStoryAppend
      expect(replayedIds).not.toContain(liveAppended[0].id);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('replays for start("new-hero") too', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-replay-newhero-'));
    try {
      const state = makeState();
      appendTranscript(state.campaign.slug, { role: 'dm', text: 'The fallen hero is mourned.', ts: 't0' }, baseDir);

      const cb = makeCallbacks();
      const controller = new GameController(state, cb, {
        baseDir,
        sessionFactory: () => new RecordingSession([]),
      });
      controller.start('new-hero');

      expect(cb.onHistoryReplay).toHaveBeenCalledTimes(1);
      const replayed = vi.mocked(cb.onHistoryReplay).mock.calls[0][0];
      expect(replayed.map((e) => e.text)).toEqual(['The fallen hero is mourned.']);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('never replays for start("new") -- there is no prior history to show', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-replay-new-'));
    try {
      const state = makeState();
      const cb = makeCallbacks();
      const controller = new GameController(state, cb, {
        baseDir,
        sessionFactory: () => new RecordingSession([]),
      });
      controller.start('new');

      expect(cb.onHistoryReplay).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

/**
 * Bug fix: resuming used to immediately bill a fresh, unwanted "what happens
 * next" DM turn on top of the just-replayed scene (see the describe block
 * above). resume must instead show the player's exact last scene (already
 * covered by the replay tests) and then WAIT -- the DM only speaks again once
 * the player actually does something. The one exception is a tail that ends
 * on a player line with no DM reply yet (they quit right after acting): that
 * pending action must not be silently dropped, so resume sends the brief
 * immediately in that case, same as the old behavior.
 */
/**
 * A dice result belongs at the point in the scene where it was rolled, and it
 * has to stay there. The web client used to get rolls only as a strip pinned
 * under the input showing the LATEST one, which meant a roll sat there for
 * turns after the scene that produced it had ended, attached to nothing.
 */
describe('dice rolls as story entries', () => {
  function rollThrough(controller: GameController, message: string): void {
    (controller as unknown as { appendRollEntry: (m: string) => void }).appendRollEntry(message);
  }

  it('appends the roll to the story and persists it in transcript order', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-roll-entry-'));
    try {
      const state = makeState();
      const cb = makeCallbacks();
      const controller = new GameController(state, cb, { baseDir });

      rollThrough(controller, '🎲 d20+2 (Attack) → [18]+2 = 20 vs DC 12 — ✓ success');

      expect(cb.onStoryAppend).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'roll', text: expect.stringContaining('d20+2') }),
      );
      const written = readTranscript(state.campaign.slug, baseDir);
      expect(written).toHaveLength(1);
      expect(written[0].role).toBe('roll');
      expect(written[0].text).toContain('✓ success');
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('keeps rolls out of the DM context brief -- the DM already saw them as tool results', () => {
    const state = makeState();
    const transcript = [
      { role: 'player' as const, text: 'I swing at the bandit.', ts: 't0' },
      { role: 'roll' as const, text: '🎲 d20+2 (Attack) → [18]+2 = 20 vs DC 12 — ✓ success', ts: 't1' },
      { role: 'dm' as const, text: 'Your blade bites deep.', ts: 't2' },
    ];
    const brief = buildContextBrief(state, transcript);
    expect(brief).toContain('I swing at the bandit.');
    expect(brief).toContain('Your blade bites deep.');
    expect(brief).not.toContain('🎲');
    expect(brief).not.toContain('vs DC 12');
  });
});

describe('GameController resume: show-and-wait vs. send-immediately', () => {
  class RecordingSession implements DmSessionLike {
    sentMessages: string[] = [];
    busy = false;
    start(): void {}
    send(text: string): void {
      this.sentMessages.push(text);
    }
    async interrupt(): Promise<void> {}
    async end(): Promise<void> {}
  }

  function startResume(
    tailEntries: Array<{ role: 'player' | 'dm' | 'system'; text: string }>,
  ): { controller: GameController; cb: ControllerCallbacks; session: RecordingSession; baseDir: string } {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-resume-contract-'));
    const state = makeState();
    tailEntries.forEach((entry, i) => {
      appendTranscript(state.campaign.slug, { role: entry.role, text: entry.text, ts: `t${i}` }, baseDir);
    });

    const cb = makeCallbacks();
    let session!: RecordingSession;
    const sessionFactory = () => {
      session = new RecordingSession();
      return session;
    };

    const controller = new GameController(state, cb, { baseDir, sessionFactory });
    controller.start('resume');

    return { controller, cb, session, baseDir };
  }

  // The quota burn: a failed turn leaves the player's line last, resume reads
  // that as "the DM never replied" and re-sends it -- so every reopen spent
  // another turn on a turn that had already failed. handleError now records a
  // system line, and that is what has to stop the re-send.
  it('does NOT re-send a player action that a recorded failure already answered', () => {
    const { cb, session, baseDir } = startResume([
      { role: 'player', text: 'I strike the bandit.' },
      { role: 'system', text: 'The weave is exhausted.\n\nThat turn did not go through, so nothing in the story changed.' },
    ]);
    try {
      expect(session.sentMessages).toHaveLength(0);
      expect(cb.onBusyChange).toHaveBeenLastCalledWith(false);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  // ...but a genuine "quit right after acting" must still be picked up.
  it('still recovers an unanswered action when nothing responded to it at all', () => {
    const { session, baseDir } = startResume([
      { role: 'dm', text: 'The square is quiet.' },
      { role: 'player', text: 'I draw my blade.' },
    ]);
    try {
      expect(session.sentMessages).toHaveLength(1);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('resume with a DM-terminated tail does NOT send to the session and leaves busy false', () => {
    const { cb, session, baseDir } = startResume([
      { role: 'player', text: 'I look around.' },
      { role: 'dm', text: 'You see a quiet square.' },
    ]);
    try {
      expect(session.sentMessages).toHaveLength(0);
      expect(cb.onBusyChange).toHaveBeenLastCalledWith(false);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('pushes the current character/world state to the UI on load, before any turn (so the panel is not empty on open)', () => {
    const { cb, baseDir } = startResume([
      { role: 'player', text: 'I look around.' },
      { role: 'dm', text: 'You see a quiet square.' },
    ]);
    try {
      // resume takes no DM turn, so nothing mutates the engine -- the state
      // must still reach the UI so the character panel renders on open.
      expect(cb.onStateChange).toHaveBeenCalledWith(
        expect.objectContaining({ character: expect.anything(), world: expect.anything() }),
      );
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("the player's next action after a DM-terminated resume gets the held brief prepended", () => {
    const { controller, cb, session, baseDir } = startResume([
      { role: 'player', text: 'I look around.' },
      { role: 'dm', text: 'You see a quiet square.' },
    ]);
    try {
      // Sanity: nothing was sent to the (memory-less, fresh) session during start().
      expect(session.sentMessages).toHaveLength(0);

      controller.submitPlayerAction('I walk toward the well.');

      expect(session.sentMessages).toHaveLength(1);
      const sent = session.sentMessages[0];
      expect(sent).toContain('[CAMPAIGN BRIEFING');
      expect(sent).toContain('[The player now acts:]');
      expect(sent).toContain('I walk toward the well.');
      expect(cb.onBusyChange).toHaveBeenLastCalledWith(true);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('resume with a PLAYER-terminated tail (quit right before the DM replied) sends the brief immediately so the DM answers it', () => {
    const { cb, session, baseDir } = startResume([
      { role: 'dm', text: 'You see a quiet square.' },
      { role: 'player', text: 'I knock on the door.' },
    ]);
    try {
      expect(session.sentMessages).toHaveLength(1);
      expect(session.sentMessages[0]).toContain('[CAMPAIGN BRIEFING');
      expect(cb.onBusyChange).toHaveBeenLastCalledWith(true);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

/**
 * The DM ends a turn with a machine-read [[SUGGEST: a | b | c]] trailer that
 * drives the tappable action chips. It must be stripped before the text
 * reaches ANY durable or player-visible surface -- the story log, the
 * transcript (and so the context brief and the chronicle summarizer), and the
 * live stream -- or the marker shows up as prose in the story the player
 * reads and in the history the DM is later fed back.
 */
describe('GameController suggested-actions trailer', () => {
  class CallbackCapturingSession implements DmSessionLike {
    busy = false;
    constructor(readonly cbs: DmSessionCallbacks) {}
    start(): void {}
    send(): void {}
    async interrupt(): Promise<void> {}
    async end(): Promise<void> {}
  }

  function startNew() {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-suggest-'));
    const state = makeState();
    const cb = makeCallbacks();
    cb.onSuggestions = vi.fn();
    let session!: CallbackCapturingSession;
    const controller = new GameController(state, cb, {
      baseDir,
      sessionFactory: (_config, cbs) => {
        session = new CallbackCapturingSession(cbs);
        return session;
      },
    });
    controller.start('new');
    return { controller, cb, session, baseDir, state };
  }

  it('keeps the trailer out of the story log and the transcript, and reports the actions', () => {
    const { cb, session, baseDir, state } = startNew();
    try {
      session.cbs.onTurnComplete({
        text: 'The constable blocks the door.\n\nWhat do you do?\n\n[[SUGGEST: Slip out the back | Bluff him | Draw your dagger]]',
      });

      const appended = vi.mocked(cb.onStoryAppend).mock.calls.map((c) => c[0]).filter((e) => e.kind === 'dm');
      expect(appended).toHaveLength(1);
      expect(appended[0].text).toBe('The constable blocks the door.\n\nWhat do you do?');
      expect(appended[0].text).not.toContain('SUGGEST');

      expect(cb.onSuggestions).toHaveBeenCalledWith([
        'Slip out the back',
        'Bluff him',
        'Draw your dagger',
      ]);

      const persisted = readTranscript(state.campaign.slug, baseDir);
      const dmLine = persisted.filter((e) => e.role === 'dm').pop();
      expect(dmLine?.text).toBe('The constable blocks the door.\n\nWhat do you do?');
      expect(JSON.stringify(persisted)).not.toContain('SUGGEST');
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('never streams the marker to the screen, even one character of it', () => {
    const { cb, session, baseDir } = startNew();
    try {
      session.cbs.onDelta('The door opens.');
      session.cbs.onDelta('\n\n[[SUG');
      session.cbs.onDelta('GEST: Go in | Wait]]');

      const streamed = vi.mocked(cb.onStreamText).mock.calls.map((c) => c[0]);
      for (const text of streamed) {
        expect(text).not.toContain('[[');
        expect(text).not.toContain('SUG');
      }
      // The prose itself still got through.
      expect(streamed.some((t) => t.indexOf('The door opens.') === 0)).toBe(true);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('clears the chips when the player acts so the previous scene\'s options cannot linger', () => {
    const { controller, cb, session, baseDir } = startNew();
    try {
      // start('new') leaves the controller busy on the opening turn, and
      // submitPlayerAction is a no-op while busy -- so finish that turn first.
      session.cbs.onTurnComplete({ text: 'An opening scene.\n[[SUGGEST: Look | Listen | Leave]]' });
      expect(cb.onSuggestions).toHaveBeenLastCalledWith(['Look', 'Listen', 'Leave']);

      vi.mocked(cb.onSuggestions!).mockClear();
      controller.submitPlayerAction('I run for the door.');
      expect(cb.onSuggestions).toHaveBeenCalledWith([]);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('reports no actions for a turn with no trailer, leaving the prose untouched', () => {
    const { cb, session, baseDir } = startNew();
    try {
      session.cbs.onTurnComplete({ text: 'You wake in a cold room.' });
      const appended = vi.mocked(cb.onStoryAppend).mock.calls.map((c) => c[0]).filter((e) => e.kind === 'dm');
      expect(appended[0].text).toBe('You wake in a cold room.');
      expect(cb.onSuggestions).toHaveBeenCalledWith([]);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
