// Integration-level tests for OpenAiDmSession's agentic loop (PR-1/PR-2/
// PR-4/PR-8), driven entirely against a mocked global.fetch (no real
// network) that returns canned OpenAI-style SSE streams. Complements the
// pure-unit tests in openaiStream.test.ts/argRepair.test.ts by proving the
// whole session wiring: streamed onDelta calls, a real engine-mutating tool
// call executed via the exact same handler the Claude backend uses, the
// interactive player-roll pause actually pausing the loop, and HTTP error
// classification.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Engine } from '../src/game/engine';
import type { EngineResult } from '../src/game/engine';
import type { GameState } from '../src/game/state';
import { createDmTools } from '../src/ai/tools';
import { OpenAiDmSession } from '../src/ai/openaiDm';
import type { DmError, DmSessionCallbacks, DmSessionConfig } from '../src/ai/dm';
import type { OpenAiStreamChunk } from '../src/ai/openaiStream';

function makeState(): GameState {
  return {
    campaign: {
      slug: 'openaidm-test',
      name: 'OpenAiDm Test',
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

function sseLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** A complete (closed) canned SSE stream from a list of chunk objects, terminated with [DONE]. */
function sseResponse(chunkObjects: OpenAiStreamChunk[], status = 200): Response {
  const text = chunkObjects.map(sseLine).join('') + 'data: [DONE]\n\n';
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

/** A stream that emits one chunk and then hangs forever, until the given AbortSignal fires -- for testing interrupt(). */
function hangingResponse(signal: AbortSignal): Response {
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller;
      controller.enqueue(new TextEncoder().encode(sseLine({ choices: [{ delta: { content: 'partial' } }] })));
      // Deliberately never close/enqueue [DONE] -- simulates a long-running request.
    },
  });
  signal.addEventListener('abort', () => {
    ctrl?.error(new DOMException('Aborted', 'AbortError'));
  });
  return new Response(stream, { status: 200 });
}

/** requestBody helper: parses the JSON body of one recorded fetch() call. */
function bodyOf(call: unknown[]): any {
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe('OpenAiDmSession', () => {
  let settingsDir: string;

  function makeSession(hooks?: Parameters<typeof createDmTools>[1]) {
    const engine = new Engine(makeState());
    const { server, allowedTools, tools } = createDmTools(engine, hooks);
    const config: DmSessionConfig = {
      systemPrompt: 'You are the test DM.',
      server,
      allowedTools,
      tools,
      model: 'test-model',
    };
    const callbacks: DmSessionCallbacks = {
      onDelta: vi.fn(),
      onToolUse: vi.fn(),
      onTurnComplete: vi.fn(),
      onSystemNote: vi.fn(),
      onError: vi.fn(),
      onRawMessage: vi.fn(),
    };
    const session = new OpenAiDmSession(config, callbacks, { settingsBaseDir: settingsDir });
    return { engine, session, callbacks };
  }

  function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (predicate()) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
        setTimeout(tick, 5);
      };
      tick();
    });
  }

  beforeEach(() => {
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-openaidm-test-'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(settingsDir, { recursive: true, force: true });
  });

  it('streams content deltas and completes the turn when the model returns no tool calls', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        { choices: [{ delta: { content: 'You ' } }] },
        { choices: [{ delta: { content: 'enter the tavern.' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { session, callbacks } = makeSession();
    session.start();
    session.send('I walk into the tavern.');

    await waitFor(() => (callbacks.onTurnComplete as any).mock.calls.length > 0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callbacks.onDelta).toHaveBeenCalledWith('You ');
    expect(callbacks.onDelta).toHaveBeenCalledWith('enter the tavern.');
    expect(callbacks.onTurnComplete).toHaveBeenCalledWith({ text: 'You enter the tavern.' });
    expect(session.busy).toBe(false);
  });

  it('executes a real (non-interactive) tool call via the exact same handler the Claude backend uses, mutating engine state, then completes on the following step', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([
          { choices: [{ delta: { content: 'You arrive. ' } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_1', type: 'function', function: { name: 'set_location', arguments: '{"name":"Cellar Door"}' } },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      )
      .mockResolvedValueOnce(
        sseResponse([
          { choices: [{ delta: { content: 'The door creaks.' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { engine, session, callbacks } = makeSession();
    session.start();
    session.send('I approach the door.');

    await waitFor(() => (callbacks.onTurnComplete as any).mock.calls.length > 0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callbacks.onToolUse).toHaveBeenCalledWith('set_location');
    expect(engine.state.world.location).toBe('Cellar Door');
    expect(callbacks.onTurnComplete).toHaveBeenCalledWith({ text: 'You arrive. The door creaks.' });

    // The second request must carry the assistant tool_calls message AND the
    // tool result message referencing the same tool_call_id, in that order.
    const secondBody = bodyOf(fetchMock.mock.calls[1]);
    const assistantMsg = secondBody.messages.find((m: any) => m.role === 'assistant' && m.tool_calls);
    const toolMsg = secondBody.messages.find((m: any) => m.role === 'tool');
    expect(assistantMsg.tool_calls[0]).toEqual({ id: 'call_1', type: 'function', function: { name: 'set_location', arguments: '{"name":"Cellar Door"}' } });
    expect(toolMsg.tool_call_id).toBe('call_1');
    expect(toolMsg.content).toContain('Cellar Door');
  });

  it("pauses the turn for a real interactive player roll (roller:'player') -- the second request is NOT sent until the interactiveRoll hook resolves", async () => {
    let resolveRoll: ((result: EngineResult) => void) | undefined;
    const interactiveRoll = vi.fn(
      () =>
        new Promise<EngineResult>((resolve) => {
          resolveRoll = resolve;
        }),
    );

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'roll_dice', arguments: '{"expr":"d20+3","reason":"Force the door","dc":13,"roller":"player"}' },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      )
      .mockResolvedValueOnce(
        sseResponse([{ choices: [{ delta: { content: 'It bursts open!' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { session, callbacks } = makeSession({ interactiveRoll });
    session.start();
    session.send('I force the door.');

    await waitFor(() => interactiveRoll.mock.calls.length > 0);
    // Give the (already-awaited) hook a moment to actually park the loop --
    // the second fetch must still not have fired.
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callbacks.onTurnComplete).not.toHaveBeenCalled();

    resolveRoll?.({ ok: true, message: '🎲 rolled 18 vs DC 13 -- success', events: [] });

    await waitFor(() => (callbacks.onTurnComplete as any).mock.calls.length > 0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callbacks.onTurnComplete).toHaveBeenCalledWith({ text: 'It bursts open!' });
  });

  it('classifies a 401 response as an auth DmError and does not call onTurnComplete', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const { session, callbacks } = makeSession();
    session.start();
    session.send('hello');

    await waitFor(() => (callbacks.onError as any).mock.calls.length > 0);

    const err: DmError = (callbacks.onError as any).mock.calls[0][0];
    expect(err.kind).toBe('auth');
    expect(callbacks.onTurnComplete).not.toHaveBeenCalled();
    expect(session.busy).toBe(false);
  });

  it('interrupt() aborts an in-flight request without firing onError/onTurnComplete, and clears busy', async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => Promise.resolve(hangingResponse(init.signal as AbortSignal)));
    vi.stubGlobal('fetch', fetchMock);

    const { session, callbacks } = makeSession();
    session.start();
    session.send('hello');
    expect(session.busy).toBe(true);

    await session.interrupt();

    expect(session.busy).toBe(false);
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onTurnComplete).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry -- an abort is not a failure to retry
  });
});
