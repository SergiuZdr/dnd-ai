// Controller smoke WITHOUT AI: import-safety + guard-logic only. start() is
// never called here (that would spin up a real DmSession/Agent SDK query) --
// these tests only prove construction is side-effect-free and that the
// busy/blank guards on submitPlayerAction hold before any session exists.

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GameController } from '../src/game/controller';
import type { ControllerCallbacks, DmSessionLike, StoryEntry } from '../src/game/controller';
import type { GameState } from '../src/game/state';
import { loadGame } from '../src/game/saves';
import { Engine } from '../src/game/engine';
import type { EngineResult } from '../src/game/engine';
import { DmError } from '../src/ai/dm';

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

    const reveal = controller.confirmRoll();

    expect(reveal?.canReroll).toBe(false);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].ok).toBe(true);
    expect(cb.onRollPrompt).toHaveBeenLastCalledWith(null);
  });

  it('confirmRoll offers a luck reroll on a failed dc when luck > 0, without resolving yet', () => {
    const state = makeState();
    state.character.luck = 1;
    const cb = makeCallbacks();
    const controller = new GameController(state, cb);
    primeEngine(controller, state);
    const resolved = primePendingRoll(controller, { expr: 'd20', reason: 'a hard check', dc: 15 });

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0); // d20 -> face 1, guaranteed to fail dc 15
    try {
      const reveal = controller.confirmRoll();
      expect(reveal?.canReroll).toBe(true);
      expect(reveal?.luck).toBe(1);
      expect(reveal?.message).toContain('✗ failure');
    } finally {
      randomSpy.mockRestore();
    }
    // Not resolved yet -- the UI still owes a resolvePendingRoll() call.
    expect(resolved).toHaveLength(0);
    expect(cb.onRollPrompt).not.toHaveBeenLastCalledWith(null);
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

  it('resolvePendingRoll(false) accepts the original roll as-is', () => {
    const state = makeState();
    state.character.luck = 2;
    const cb = makeCallbacks();
    const controller = new GameController(state, cb);
    primeEngine(controller, state);
    const resolved = primePendingRoll(controller, { expr: 'd20', reason: 'a hard check', dc: 15 });

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      controller.confirmRoll();
    } finally {
      randomSpy.mockRestore();
    }
    controller.resolvePendingRoll(false);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].ok).toBe(true);
    expect(state.character.luck).toBe(2); // untouched -- luck only spends on useLuck: true
  });

  it('resolvePendingRoll(true) spends 1 luck, rerolls, and keeps the better total', () => {
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
    try {
      controller.resolvePendingRoll(true);
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
});
