// Which endpoint does the chronicler actually call, per settings.dmBackend?
//
// This file exists because that routing had NO coverage at all, and a real bug
// hid in the gap: summarizeChunk() branched on `dmBackend === 'openai'` only, so
// dmBackend:"dual" -- the configuration actually in use -- fell through to the
// Claude Agent SDK path. Locally that quietly billed Claude tokens on a backend
// picked specifically to bill none; on the headless cloud host, where no Claude
// Code login exists, it threw on every chronicle update, so lastSummarizedIndex
// never advanced and resume replayed the whole transcript.
//
// The mocking mirrors defaultSessionFactory.test.ts: loadSettings is mocked so
// no real settings.json/env is read, `query` is mocked to prove the Claude path
// is NOT taken (and to stand in for it when it should be), and global.fetch
// returns a canned one-shot completion.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LoadedSettings, Settings } from '../../src/game/settings';
import type { TranscriptEntry } from '../../src/game/saves';

const loadSettingsMock = vi.fn<() => LoadedSettings>();
const queryMock = vi.fn();

vi.mock('../../src/game/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/game/settings')>();
  return { ...actual, loadSettings: () => loadSettingsMock() };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

// Imported AFTER the mocks so summarizer.ts's own imports resolve to them.
const { summarizeChunk } = await import('../../src/ai/summarizer');

const CHUNK: TranscriptEntry[] = [
  { role: 'player', text: 'I force the door.', ts: '2024-01-01T00:00:00.000Z' },
  { role: 'dm', text: 'It gives way with a crack of splintering pine.', ts: '2024-01-01T00:00:01.000Z' },
];

const REPLY = 'CHAPTER SUMMARY:\nThe hero forced a door.\nSTORY SO FAR:\nA door lies broken behind them.';

function settingsWithBackend(dmBackend: Settings['dmBackend']): LoadedSettings {
  return {
    settings: {
      dmModel: 'haiku',
      summarizerModel: 'haiku',
      dmBackend,
      openai: {
        baseUrl: 'https://endpoint.example/api/v1',
        model: 'referee-model',
        narratorModel: 'narrator-model',
        apiKeyEnv: 'TEST_CHRONICLER_KEY',
      },
    },
  };
}

/** The non-streaming JSON body callOpenAiChatOnce() reads (`stream: false`). */
function jsonCompletion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** One request body as the code actually sent it. */
function sentBody(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string);
}

describe('summarizeChunk backend routing', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    loadSettingsMock.mockReset();
    queryMock.mockReset();
    fetchMock = vi.fn(async () => jsonCompletion(REPLY));
    global.fetch = fetchMock as unknown as typeof fetch;
    process.env.TEST_CHRONICLER_KEY = 'sk-test-chronicler';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.TEST_CHRONICLER_KEY;
  });

  it('dmBackend:"dual" uses the OpenAI-compatible endpoint and never touches the Claude SDK', async () => {
    loadSettingsMock.mockReturnValue(settingsWithBackend('dual'));

    const result = await summarizeChunk({ chunk: CHUNK, storySoFar: 'Previously...' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://endpoint.example/api/v1/chat/completions');
    // The whole point: no Claude token is spent, and nothing needs a Claude
    // Code login to be present.
    expect(queryMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      chapterSummary: 'The hero forced a door.',
      storySoFar: 'A door lies broken behind them.',
    });
  });

  it('dmBackend:"dual" summarizes with the REFEREE model, not the narrator', async () => {
    loadSettingsMock.mockReturnValue(settingsWithBackend('dual'));

    await summarizeChunk({ chunk: CHUNK, storySoFar: '' });

    // Faithful structured summarization is the reliable tool-caller's job; the
    // permissive narrator model is chosen for prose, not for accuracy.
    expect(sentBody(fetchMock).model).toBe('referee-model');
    expect(sentBody(fetchMock).model).not.toBe('narrator-model');
  });

  it('dmBackend:"openai" behaves identically (unchanged by the dual fix)', async () => {
    loadSettingsMock.mockReturnValue(settingsWithBackend('openai'));

    await summarizeChunk({ chunk: CHUNK, storySoFar: '' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody(fetchMock).model).toBe('referee-model');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('an explicit model override still wins over the endpoint default on both OpenAI paths', async () => {
    for (const backend of ['openai', 'dual'] as const) {
      fetchMock.mockClear();
      loadSettingsMock.mockReturnValue(settingsWithBackend(backend));

      await summarizeChunk({ chunk: CHUNK, storySoFar: '', model: 'explicit-cheap-model' });

      expect(sentBody(fetchMock).model).toBe('explicit-cheap-model');
    }
  });

  it('sends the chronicler prompt as a single non-streaming user message with the API key attached', async () => {
    loadSettingsMock.mockReturnValue(settingsWithBackend('dual'));

    await summarizeChunk({ chunk: CHUNK, storySoFar: 'Previously...' });

    const body = sentBody(fetchMock);
    expect(body.stream).toBe(false);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toContain('Previously...');
    expect(messages[0].content).toContain('PLAYER: I force the door.');

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test-chronicler');
  });

  it('dmBackend:"claude" still routes to the Agent SDK and makes no HTTP call', async () => {
    loadSettingsMock.mockReturnValue(settingsWithBackend('claude'));
    queryMock.mockReturnValue(
      (async function* () {
        yield { type: 'result', subtype: 'success', result: REPLY };
      })(),
    );

    const result = await summarizeChunk({ chunk: CHUNK, storySoFar: '' });

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.chapterSummary).toBe('The hero forced a door.');
  });

  it('surfaces an endpoint HTTP failure as a throw the controller can catch', async () => {
    loadSettingsMock.mockReturnValue(settingsWithBackend('dual'));
    fetchMock.mockResolvedValue(new Response('nope', { status: 400 }));

    await expect(summarizeChunk({ chunk: CHUNK, storySoFar: '' })).rejects.toThrow(/HTTP 400/);
  });
});
