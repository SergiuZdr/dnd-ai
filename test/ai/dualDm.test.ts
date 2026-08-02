// Tests for the dual referee+narrator DM backend (src/ai/dualDm.ts). Mocks
// global.fetch to return canned OpenAI-style SSE streams -- no network --
// mirroring test/openaiDm.test.ts's approach, but exercising the two-phase
// contract: the REFEREE phase runs the agentic tool loop (same machinery as
// OpenAiDmSession) and its streamed content must NOT reach onDelta (it's
// internal beat-sheet text); the NARRATOR phase is a second, tools-free
// completion whose streamed content DOES reach onDelta and becomes the
// text handed to onTurnComplete.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Engine } from '../../src/game/engine';
import type { EngineResult } from '../../src/game/engine';
import type { GameState } from '../../src/game/state';
import { createDmTools } from '../../src/ai/tools';
import {
  DualModelDmSession,
  formatToolOutcomes,
  buildNarratorUserPrompt,
  describeCondition,
  formatHeroGroundTruth,
} from '../../src/ai/dualDm';
import type { ToolOutcomeRecord } from '../../src/ai/dualDm';
import type { DmError, DmSessionCallbacks, DmSessionConfig } from '../../src/ai/dm';
import type { OpenAiStreamChunk } from '../../src/ai/openaiStream';

function makeState(): GameState {
  return {
    campaign: {
      slug: 'dualdm-test',
      name: 'DualDm Test',
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

/** requestBody helper: parses the JSON body of one recorded fetch() call. */
function bodyOf(call: unknown[]): any {
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe('DualModelDmSession', () => {
  let settingsDir: string;

  function writeDualSettings(overrides?: Record<string, unknown>) {
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        dmModel: 'haiku',
        summarizerModel: 'haiku',
        dmBackend: 'dual',
        openai: {
          baseUrl: 'http://127.0.0.1:11434/v1',
          model: 'referee-model',
          narratorModel: 'narrator-model',
        },
        ...overrides,
      }),
    );
  }

  function makeSession(hooks?: Parameters<typeof createDmTools>[1], sessionOpts?: { stallTimeoutMs?: number }) {
    const engine = new Engine(makeState());
    const { server, allowedTools, tools } = createDmTools(engine, hooks);
    const config: DmSessionConfig = {
      systemPrompt: 'unused by DualModelDmSession -- it builds its own referee/narrator prompts',
      server,
      allowedTools,
      tools,
      contentRating: 'PG-13',
      stateSnapshot: () => engine.state,
    };
    const callbacks: DmSessionCallbacks = {
      onDelta: vi.fn(),
      onToolUse: vi.fn(),
      onTurnComplete: vi.fn(),
      onSystemNote: vi.fn(),
      onError: vi.fn(),
      onRawMessage: vi.fn(),
    };
    const session = new DualModelDmSession(config, callbacks, { settingsBaseDir: settingsDir, ...sessionOpts });
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
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-dualdm-test-'));
    writeDualSettings();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(settingsDir, { recursive: true, force: true });
  });

  it('runs the referee tool loop, then the narrator phase, and only narrator content reaches onDelta/onTurnComplete', async () => {
    const fetchMock = vi
      .fn()
      // Referee call #1: calls set_location, no content of its own.
      .mockResolvedValueOnce(
        sseResponse([
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
      // Referee call #2: the beat sheet (no more tool calls).
      .mockResolvedValueOnce(
        sseResponse([
          { choices: [{ delta: { content: 'Player approached the door. set_location -> Cellar Door.' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      )
      // Narrator call: the player-facing prose.
      .mockResolvedValueOnce(
        sseResponse([
          { choices: [{ delta: { content: 'You reach ' } }] },
          { choices: [{ delta: { content: 'the cellar door.' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { engine, session, callbacks } = makeSession();
    session.start();
    session.send('I approach the door.');

    await waitFor(() => (callbacks.onTurnComplete as any).mock.calls.length > 0);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(engine.state.world.location).toBe('Cellar Door');

    // Referee content ("Player approached the door...") must NEVER reach onDelta.
    const deltaCalls = (callbacks.onDelta as any).mock.calls.map((c: any[]) => c[0]);
    expect(deltaCalls).toEqual(['You reach ', 'the cellar door.']);
    expect(deltaCalls.join('')).not.toContain('set_location ->');

    // onToolUse still fires for the referee's tool call (dice/tool UI feedback).
    expect(callbacks.onToolUse).toHaveBeenCalledWith('set_location');

    // onTurnComplete carries ONLY the narrator's prose.
    expect(callbacks.onTurnComplete).toHaveBeenCalledWith({ text: 'You reach the cellar door.' });
    expect(session.busy).toBe(false);

    // Narrator request must have no tools/tool_choice field at all.
    const narratorBody = bodyOf(fetchMock.mock.calls[2]);
    expect(narratorBody.model).toBe('narrator-model');
    expect(narratorBody.tools).toBeUndefined();
    expect(narratorBody.tool_choice).toBeUndefined();

    // Referee request used the referee model and carried the tool schemas.
    const refereeBody = bodyOf(fetchMock.mock.calls[0]);
    expect(refereeBody.model).toBe('referee-model');
    expect(Array.isArray(refereeBody.tools)).toBe(true);
    expect(refereeBody.tools.length).toBeGreaterThan(0);
  });

  // Regression for the "I drink a tincture to heal" turn: the referee produced
  // a beat sheet and called nothing, so HP and inventory never moved -- while
  // the narrator went on to describe the heal as having happened. The referee
  // now gets exactly one nudge to make the calls it skipped.
  it('re-prompts the referee once when a turn produced no tool calls, and applies the tools it then makes', async () => {
    const fetchMock = vi
      .fn()
      // Referee call #1: beat sheet only -- the bug. No tool calls at all.
      .mockResolvedValueOnce(
        sseResponse([
          { choices: [{ delta: { content: 'The hero drinks a tincture and heads down the ramp.' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      )
      // Referee call #2: after the nudge, it actually resolves the mechanics.
      .mockResolvedValueOnce(
        sseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'c1', type: 'function', function: { name: 'heal', arguments: '{"amount":4,"reason":"tincture"}' } },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      )
      // Referee call #3: the corrected beat sheet.
      .mockResolvedValueOnce(
        sseResponse([
          { choices: [{ delta: { content: 'heal -> +4 HP.' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      )
      // Narrator.
      .mockResolvedValueOnce(
        sseResponse([
          { choices: [{ delta: { content: 'The bitter liquid knits your wounds.' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { engine, session, callbacks } = makeSession();
    engine.state.character.hp = 7;
    engine.state.character.maxHp = 13;
    session.start();
    session.send("i use one of aldric's tinctures to heal");

    await waitFor(() => (callbacks.onTurnComplete as any).mock.calls.length > 0);

    // The whole point: the heal actually landed on the engine this time.
    expect(engine.state.character.hp).toBe(11);
    expect(callbacks.onToolUse).toHaveBeenCalledWith('heal');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // The nudge went to the referee as a user message before call #2.
    const nudged = bodyOf(fetchMock.mock.calls[1]).messages.at(-1);
    expect(nudged.role).toBe('user');
    expect(nudged.content).toContain('without calling a single tool');

    // And the narrator was handed the corrected, real numbers.
    const narratorPrompt = bodyOf(fetchMock.mock.calls[3]).messages.at(-1).content;
    expect(narratorPrompt).toContain('HP 11/13');
    expect(narratorPrompt).not.toContain('resolved NOTHING mechanical');
  });

  it('nudges at most once, so a genuinely mechanics-free turn still ends after one extra call', async () => {
    const beatSheetOnly = () =>
      sseResponse([
        { choices: [{ delta: { content: 'The hero just looks around. Nothing mechanical.' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(beatSheetOnly()) // referee #1: nothing
      .mockResolvedValueOnce(beatSheetOnly()) // referee #2: after the nudge, still nothing -- fine
      .mockResolvedValueOnce(
        sseResponse([
          { choices: [{ delta: { content: 'Dust hangs in the lantern light.' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { session, callbacks } = makeSession();
    session.start();
    session.send('i look around');

    await waitFor(() => (callbacks.onTurnComplete as any).mock.calls.length > 0);

    // Exactly one retry, then it accepts the empty turn and narrates.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(callbacks.onTurnComplete).toHaveBeenCalledWith({ text: 'Dust hangs in the lantern light.' });

    // Narrator is explicitly told nothing happened, so it can't invent a heal.
    const narratorPrompt = bodyOf(fetchMock.mock.calls[2]).messages.at(-1).content;
    expect(narratorPrompt).toContain('resolved NOTHING mechanical this turn');
  });

  it("pauses the turn for a real interactive player roll (roller:'player') during the referee phase -- the narrator is not called until the roll resolves", async () => {
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
        sseResponse([{ choices: [{ delta: { content: 'Door forced open on an 18 vs DC 13.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]),
      )
      .mockResolvedValueOnce(
        sseResponse([{ choices: [{ delta: { content: 'It bursts open!' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { session, callbacks } = makeSession({ interactiveRoll });
    session.start();
    session.send('I force the door.');

    await waitFor(() => interactiveRoll.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 20));
    // Only the first referee request has gone out -- neither the referee's
    // follow-up step nor the narrator phase has run yet.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callbacks.onTurnComplete).not.toHaveBeenCalled();
    expect(callbacks.onDelta).not.toHaveBeenCalled();

    resolveRoll?.({ ok: true, message: '🎲 rolled 18 vs DC 13 -- success', events: [] });

    await waitFor(() => (callbacks.onTurnComplete as any).mock.calls.length > 0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(callbacks.onTurnComplete).toHaveBeenCalledWith({ text: 'It bursts open!' });
  });

  it('classifies a 401 response during the referee phase as an auth DmError and never reaches the narrator', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const { session, callbacks } = makeSession();
    session.start();
    session.send('hello');

    await waitFor(() => (callbacks.onError as any).mock.calls.length > 0);

    const err: DmError = (callbacks.onError as any).mock.calls[0][0];
    expect(err.kind).toBe('auth');
    expect(callbacks.onTurnComplete).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1); // never got to the narrator
    expect(session.busy).toBe(false);
  });

  it('classifies a narrator-phase HTTP failure as a DmError, after the referee already ran', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([{ choices: [{ delta: { content: 'Nothing much happens.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]),
      )
      .mockResolvedValueOnce(new Response('server error', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const { session, callbacks } = makeSession();
    session.start();
    session.send('I wait.');

    await waitFor(() => (callbacks.onError as any).mock.calls.length > 0);

    const err: DmError = (callbacks.onError as any).mock.calls[0][0];
    expect(err.kind).toBe('unknown');
    expect(callbacks.onTurnComplete).not.toHaveBeenCalled();
    expect(session.busy).toBe(false);
  });

  it('interrupt() aborts an in-flight referee request without firing onError/onTurnComplete, and clears busy', async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          ctrl = controller;
          controller.enqueue(new TextEncoder().encode(sseLine({ choices: [{ delta: { content: 'partial' } }] })));
        },
      });
      (init.signal as AbortSignal).addEventListener('abort', () => {
        ctrl?.error(new DOMException('Aborted', 'AbortError'));
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { session, callbacks } = makeSession();
    session.start();
    session.send('hello');
    expect(session.busy).toBe(true);

    await session.interrupt();

    expect(session.busy).toBe(false);
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onTurnComplete).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to openai.model for the narrator, with a friendly onSystemNote, when narratorModel is unset', async () => {
    writeDualSettings({ openai: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'referee-model' } });

    // This turn calls no tools, so the referee gets its one zero-tool nudge --
    // hence two referee responses before the narrator's.
    const beatSheetOnly = () =>
      sseResponse([{ choices: [{ delta: { content: 'Beat sheet.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(beatSheetOnly())
      .mockResolvedValueOnce(beatSheetOnly())
      .mockResolvedValueOnce(
        sseResponse([{ choices: [{ delta: { content: 'Narration.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { session, callbacks } = makeSession();
    session.start();

    expect(callbacks.onSystemNote).toHaveBeenCalledWith(expect.stringContaining('openai.narratorModel is not set'));

    session.send('hello');
    await waitFor(() => (callbacks.onTurnComplete as any).mock.calls.length > 0);

    const refereeBody = bodyOf(fetchMock.mock.calls[0]);
    const narratorBody = bodyOf(fetchMock.mock.calls[2]);
    expect(refereeBody.model).toBe('referee-model');
    expect(narratorBody.model).toBe('referee-model'); // fell back to the referee's model
  });

  // Both of these are live-playtest failures, not hypotheticals: on one turn
  // the narrator returned an empty stream and killed the turn outright, and on
  // another the provider opened a stream and never sent a byte, leaving the
  // game "thinking" for five minutes with only STOP as a way out.
  describe('surviving a flaky free-tier provider', () => {
    const beatSheetOnly = () =>
      sseResponse([{ choices: [{ delta: { content: 'Beat sheet.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    /** A stream that yields no content at all -- the empty narration a free model intermittently returns. */
    const emptyStream = () => sseResponse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);

    it('retries an empty narration once and delivers the second attempt', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(beatSheetOnly())
        .mockResolvedValueOnce(beatSheetOnly()) // the zero-tool nudge
        .mockResolvedValueOnce(emptyStream()) // narrator returns nothing
        .mockResolvedValueOnce(
          sseResponse([{ choices: [{ delta: { content: 'The shutters bang open.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]),
        );
      vi.stubGlobal('fetch', fetchMock);

      const { session, callbacks } = makeSession();
      session.start();
      session.send('knock on the door');
      await waitFor(() => (callbacks.onTurnComplete as any).mock.calls.length > 0);

      expect((callbacks.onTurnComplete as any).mock.calls[0][0].text).toBe('The shutters bang open.');
      expect(callbacks.onError).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('gives up honestly when the narration is empty twice', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(beatSheetOnly())
        .mockResolvedValueOnce(beatSheetOnly())
        .mockResolvedValueOnce(emptyStream())
        .mockResolvedValueOnce(emptyStream());
      vi.stubGlobal('fetch', fetchMock);

      const { session, callbacks } = makeSession();
      session.start();
      session.send('knock on the door');
      await waitFor(() => (callbacks.onError as any).mock.calls.length > 0);

      expect((callbacks.onError as any).mock.calls[0][0].friendly).toMatch(/returned nothing/i);
      expect(callbacks.onTurnComplete).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(4); // one retry, not an endless loop
    });

    it('breaks a stream that opens and then goes silent, instead of hanging the turn forever', async () => {
      // Never enqueues anything; errors only when the request is aborted, the
      // same way a real fetch body does.
      const stallingResponse = (signal?: AbortSignal | null) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
            },
          }),
          { status: 200 },
        );
      const fetchMock = vi.fn((_url: string, init: RequestInit) => Promise.resolve(stallingResponse(init?.signal)));
      vi.stubGlobal('fetch', fetchMock);

      const { session, callbacks } = makeSession(undefined, { stallTimeoutMs: 40 });
      session.start();
      session.send('walk into the cave');
      await waitFor(() => (callbacks.onError as any).mock.calls.length > 0);

      const err = (callbacks.onError as any).mock.calls[0][0];
      expect(err.friendly).toMatch(/went quiet mid-turn/i);
      expect(err.friendly).toMatch(/referee/i);
      expect(session.busy).toBe(false); // the turn ended -- the player is not stuck
    });

    it('stays silent when the player interrupts, rather than reporting a stall', async () => {
      const fetchMock = vi.fn((_url: string, init: RequestInit) =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
              },
            }),
            { status: 200 },
          ),
        ),
      );
      vi.stubGlobal('fetch', fetchMock);

      // A generous timeout, so nothing but the explicit interrupt can end this turn.
      const { session, callbacks } = makeSession(undefined, { stallTimeoutMs: 60_000 });
      session.start();
      session.send('wait here');
      await waitFor(() => session.busy);
      await session.interrupt();

      expect(callbacks.onError).not.toHaveBeenCalled();
    });
  });
});

describe('formatToolOutcomes', () => {
  it('reports "(no tool calls...)" for an empty turn', () => {
    expect(formatToolOutcomes([])).toMatch(/no tool calls this turn/);
  });

  it('renders one line per record, marking failures distinctly from successes', () => {
    const records: ToolOutcomeRecord[] = [
      { tool: 'roll_dice', args: { expr: 'd20+3' }, ok: true, resultText: '🎲 d20+3 -> 18 vs DC 13 -- success' },
      { tool: 'spend_gold', args: { amount: 1000 }, ok: false, resultText: 'ERROR: not enough gold' },
    ];
    const text = formatToolOutcomes(records);
    expect(text).toContain('- roll_dice: 🎲 d20+3 -> 18 vs DC 13 -- success');
    expect(text).toContain('- spend_gold: FAILED -- ERROR: not enough gold');
  });
});

describe('buildNarratorUserPrompt', () => {
  it('strips the referee-only <system-reminder> mechanics nudge out of the player text', () => {
    const withReminder = 'I force the door.\n\n<system-reminder>DM mechanics check: ...</system-reminder>';
    const prompt = buildNarratorUserPrompt(withReminder, 'Beat sheet text.', []);
    expect(prompt).toContain('I force the door.');
    expect(prompt).not.toContain('<system-reminder>');
    expect(prompt).not.toContain('DM mechanics check');
  });

  it('surfaces a STORY SO FAR/RECENT CHAPTERS brief hint when the incoming text carries a campaign brief', () => {
    const brief =
      '[CAMPAIGN BRIEFING — internal; read it, then resume the scene]\n' +
      'STORY SO FAR: The hero fled the burning keep.\n' +
      'RECENT CHAPTERS:\n- Escaped the keep.\n' +
      'CURRENT STATE (ground truth JSON):\n{}\n' +
      '[The player now acts:]\nI look around.';
    const prompt = buildNarratorUserPrompt(brief, 'Beat sheet.', []);
    expect(prompt).toContain('STORY SO FAR: The hero fled the burning keep.');
    expect(prompt).toContain('I look around.');
  });

  it('embeds the beat sheet and tool-outcome record verbatim', () => {
    const records: ToolOutcomeRecord[] = [
      { tool: 'apply_damage', args: { amount: 4 }, ok: true, resultText: 'Hero takes 4 damage: 12 -> 8 HP.' },
    ];
    const prompt = buildNarratorUserPrompt('I fight back.', 'The goblin lands a hit.', records);
    expect(prompt).toContain('The goblin lands a hit.');
    expect(prompt).toContain('- apply_damage: Hero takes 4 damage: 12 -> 8 HP.');
  });

  // Regression: the narrator once wrote "your HP climbs to eleven of thirteen"
  // and described a tincture being drained on a turn where the referee called
  // no tools at all -- HP and inventory never moved, so the prose and the
  // character sheet disagreed and the prose won in the player's head.
  describe('when the referee resolved nothing mechanical', () => {
    function woundedState(): GameState {
      const state = makeState();
      state.character.hp = 7;
      state.character.maxHp = 13;
      state.character.inventory = [{ name: "Aldric's Tinctures & Extracts (5 bottles)", qty: 1 }];
      return state;
    }

    it('hands the narrator the hero\'s real post-turn numbers to narrate against', () => {
      const prompt = buildNarratorUserPrompt(
        "we rush down the path and i use one of aldric's tinctures to heal",
        'The hero moves down the ramp.',
        [],
        woundedState(),
      );
      expect(prompt).toContain('HP 7/13');
      expect(prompt).toContain("Carrying: Aldric's Tinctures & Extracts (5 bottles) x1");
      expect(prompt).toContain('GROUND TRUTH');
    });

    it('tells the narrator in as many words that an attempted action did NOT take effect', () => {
      const prompt = buildNarratorUserPrompt('i drink a tincture', '', [], woundedState());
      expect(prompt).toContain('resolved NOTHING mechanical this turn');
      expect(prompt).toContain('has NOT taken effect');
      expect(prompt).toMatch(/do not describe an item being used up/);
    });

    it('omits the not-taken-effect warning when tools DID run', () => {
      const records: ToolOutcomeRecord[] = [
        { tool: 'heal', args: { amount: 4 }, ok: true, resultText: 'Hero heals 4: 7 -> 11 HP.' },
      ];
      const prompt = buildNarratorUserPrompt('i drink a tincture', 'The hero heals.', records, woundedState());
      expect(prompt).not.toContain('resolved NOTHING mechanical');
      expect(prompt).toContain('- heal: Hero heals 4: 7 -> 11 HP.');
    });

    it('still builds a valid prompt when no state snapshot is available', () => {
      const prompt = buildNarratorUserPrompt('i look around', 'Nothing happens.', []);
      expect(prompt).not.toContain('GROUND TRUTH');
      expect(prompt).toContain('Nothing happens.');
    });
  });
});

/**
 * Live-playtest defect: handed a bare "HP 5/12", the narrator wrote the
 * hero fading into "hollow silence" -- a death scene -- on a turn where the
 * enemy attack had MISSED. The condition line states the reading outright so
 * the model has nothing left to infer wrongly.
 */
describe('describeCondition', () => {
  it('says CONSCIOUS and forbids collapse for any hp above 0', () => {
    for (const hp of [1, 2, 5, 8, 11, 12]) {
      const text = describeCondition(hp, 12);
      expect(text, 'hp=' + hp).toMatch(/CONSCIOUS/);
      expect(text, 'hp=' + hp).toMatch(/do NOT narrate collapse/i);
      expect(text, 'hp=' + hp).not.toMatch(/^DOWN/);
    }
  });

  it('only reports DOWN at 0 hp or below, and that is the one state allowing death', () => {
    for (const hp of [0, -1, -7]) {
      const text = describeCondition(hp, 12);
      expect(text, 'hp=' + hp).toMatch(/^DOWN/);
      expect(text, 'hp=' + hp).toMatch(/death/i);
    }
  });

  it('scales the wording with how hurt they are', () => {
    expect(describeCondition(12, 12)).toMatch(/unhurt/);
    expect(describeCondition(10, 12)).toMatch(/lightly hurt/);
    expect(describeCondition(5, 12)).toMatch(/wounded/);
    expect(describeCondition(2, 12)).toMatch(/badly wounded/);
  });

  it('does not divide by zero on a degenerate maxHp', () => {
    expect(() => describeCondition(0, 0)).not.toThrow();
    expect(describeCondition(1, 0)).toMatch(/CONSCIOUS/);
  });
});

describe('narrator ground truth + per-turn constraints', () => {
  function heroState(hp: number): GameState {
    return {
      campaign: { slug: 's', name: 'S', createdAt: 't', updatedAt: 't', contentRating: 'PG-13' },
      character: {
        name: 'Bran', className: 'Ranger', race: 'Dwarf', background: '', backgroundFact: '',
        level: 1, xp: 0, hp, maxHp: 12, ac: 16,
        stats: { str: 15, dex: 15, con: 15, int: 12, wis: 10, cha: 8 },
        gold: 15, inventory: [{ name: 'Shortsword', qty: 1 }], luck: 0,
      },
      world: { theme: 't', location: 'Salthollow', npcs: [], quests: [], facts: [] },
      chronicle: { storySoFar: '', chapters: [], lastSummarizedIndex: 0 },
    };
  }

  it('puts the condition line in the hero sheet the narrator reads', () => {
    const sheet = formatHeroGroundTruth(heroState(5));
    expect(sheet).toContain('HP 5/12');
    expect(sheet).toMatch(/Condition: .*CONSCIOUS/);
    expect(sheet).toContain('Shortsword x1');
  });

  it('tells the narrator not to escalate, and to keep suggestions to carried items', () => {
    const prompt = buildNarratorUserPrompt('I retreat.', 'The bandit attacked and missed.', [], heroState(5));
    expect(prompt).toMatch(/STAY INSIDE THE FACTS/);
    expect(prompt).toMatch(/missed leaves them untouched/i);
    expect(prompt).toMatch(/never suggest using an item that is not in the Carrying list/i);
  });
});
