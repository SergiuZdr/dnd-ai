// Controller smoke WITHOUT AI: import-safety + guard-logic only. start() is
// never called here (that would spin up a real DmSession/Agent SDK query) --
// these tests only prove construction is side-effect-free and that the
// busy/blank guards on submitPlayerAction hold before any session exists.

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GameController } from '../src/game/controller';
import type { ControllerCallbacks, StoryEntry } from '../src/game/controller';
import type { GameState } from '../src/game/state';
import { loadGame } from '../src/game/saves';

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
      level: 1,
      xp: 0,
      hp: 12,
      maxHp: 12,
      ac: 15,
      stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
      gold: 10,
      inventory: [],
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
