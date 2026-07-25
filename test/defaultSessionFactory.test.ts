// Unit test for GameController's real (non-test) sessionFactory: given
// settings.json's dmBackend, does it construct the right DmSessionLike
// class? 'claude' -> DmSession (Claude Agent SDK), 'openai' -> OpenAiDmSession,
// 'dual' -> DualModelDmSession (the new referee+narrator split backend).
// loadSettings() is mocked here so the test never touches a real
// settings.json/env -- see src/game/controller.ts's defaultSessionFactory,
// exported specifically so this selection logic can be exercised directly.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LoadedSettings, Settings } from '../src/game/settings';
import { Engine } from '../src/game/engine';
import type { GameState } from '../src/game/state';
import { createDmTools } from '../src/ai/tools';
import { DmSession } from '../src/ai/dm';
import type { DmSessionCallbacks, DmSessionConfig } from '../src/ai/dm';
import { OpenAiDmSession } from '../src/ai/openaiDm';
import { DualModelDmSession } from '../src/ai/dualDm';

const loadSettingsMock = vi.fn<() => LoadedSettings>();

vi.mock('../src/game/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/game/settings')>();
  return { ...actual, loadSettings: () => loadSettingsMock() };
});

// Imported AFTER the mock is registered so controller.ts's own
// `import { loadSettings } from './settings'` resolves to the mocked version.
const { defaultSessionFactory } = await import('../src/game/controller');

function makeState(): GameState {
  return {
    campaign: {
      slug: 'session-factory-test',
      name: 'Session Factory Test',
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

function settingsWithBackend(dmBackend: Settings['dmBackend']): LoadedSettings {
  return {
    settings: {
      dmModel: 'haiku',
      summarizerModel: 'haiku',
      dmBackend,
      openai: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'referee-model', narratorModel: 'narrator-model' },
    },
  };
}

function makeConfigAndCallbacks(): { config: DmSessionConfig; callbacks: DmSessionCallbacks } {
  const engine = new Engine(makeState());
  const { server, allowedTools, tools } = createDmTools(engine);
  const config: DmSessionConfig = {
    systemPrompt: 'test prompt',
    server,
    allowedTools,
    tools,
    contentRating: 'PG-13',
  };
  const callbacks: DmSessionCallbacks = {
    onDelta: vi.fn(),
    onTurnComplete: vi.fn(),
  };
  return { config, callbacks };
}

describe('defaultSessionFactory (dmBackend -> DmSessionLike selection)', () => {
  beforeEach(() => {
    loadSettingsMock.mockReset();
  });

  it('constructs DmSession for dmBackend:"claude" (the default)', () => {
    loadSettingsMock.mockReturnValue(settingsWithBackend('claude'));
    const { config, callbacks } = makeConfigAndCallbacks();
    const session = defaultSessionFactory(config, callbacks);
    expect(session).toBeInstanceOf(DmSession);
  });

  it('constructs OpenAiDmSession for dmBackend:"openai"', () => {
    loadSettingsMock.mockReturnValue(settingsWithBackend('openai'));
    const { config, callbacks } = makeConfigAndCallbacks();
    const session = defaultSessionFactory(config, callbacks);
    expect(session).toBeInstanceOf(OpenAiDmSession);
  });

  it('constructs DualModelDmSession for dmBackend:"dual"', () => {
    loadSettingsMock.mockReturnValue(settingsWithBackend('dual'));
    const { config, callbacks } = makeConfigAndCallbacks();
    const session = defaultSessionFactory(config, callbacks);
    expect(session).toBeInstanceOf(DualModelDmSession);
  });
});
