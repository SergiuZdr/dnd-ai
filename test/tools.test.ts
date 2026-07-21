// Exercises createDmTools' roll_dice handler directly (via the exposed raw
// `tools` array) rather than through the real MCP server -- proves the
// roller:'player' + interactiveRoll branching and the "everything else is
// unaffected" fallback without spinning up the Agent SDK at all.

import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../src/game/engine';
import type { EngineResult } from '../src/game/engine';
import type { GameState } from '../src/game/state';
import { createDmTools } from '../src/ai/tools';
import type { InteractiveRollRequest } from '../src/ai/tools';

function makeState(): GameState {
  return {
    campaign: {
      slug: 'tools-test',
      name: 'Tools Test',
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

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('');
}

function findRollDice(tools: ReturnType<typeof createDmTools>['tools']) {
  const rollDice = tools.find((t) => t.name === 'roll_dice');
  if (!rollDice) throw new Error('roll_dice tool not found');
  return rollDice;
}

describe('createDmTools roll_dice', () => {
  it('rolls instantly via the engine when no interactiveRoll hook is registered, regardless of roller', async () => {
    const engine = new Engine(makeState());
    const onToolResult = vi.fn();
    const { tools } = createDmTools(engine, { onToolResult });
    const rollDice = findRollDice(tools);

    const result: any = await rollDice.handler({ expr: 'd20', reason: 'test', roller: 'player' }, undefined);

    expect(textOf(result)).toContain('🎲');
    expect(onToolResult).toHaveBeenCalledWith('roll_dice', expect.objectContaining({ ok: true }));
  });

  it("awaits hooks.interactiveRoll instead of the engine when roller:'player' and a hook is registered", async () => {
    const engine = new Engine(makeState());
    const engineSpy = vi.spyOn(engine, 'rollDice');
    const interactiveRoll = vi.fn(
      async (): Promise<EngineResult> => ({ ok: true, message: 'INTERACTIVE RESULT', events: [] }),
    );
    const onToolResult = vi.fn();
    const { tools } = createDmTools(engine, { onToolResult, interactiveRoll });
    const rollDice = findRollDice(tools);

    const result: any = await rollDice.handler(
      { expr: 'd20', mode: 'advantage', reason: 'Persuasion', dc: 13, roller: 'player' },
      undefined,
    );

    expect(interactiveRoll).toHaveBeenCalledWith({ expr: 'd20', mode: 'advantage', reason: 'Persuasion', dc: 13 });
    expect(engineSpy).not.toHaveBeenCalled();
    expect(textOf(result)).toBe('INTERACTIVE RESULT');
    expect(onToolResult).toHaveBeenCalledWith(
      'roll_dice',
      expect.objectContaining({ ok: true, message: 'INTERACTIVE RESULT' }),
    );
  });

  it("does NOT use the interactive hook when roller:'dm', even though a hook is registered", async () => {
    const engine = new Engine(makeState());
    const engineSpy = vi.spyOn(engine, 'rollDice');
    const interactiveRoll = vi.fn(
      async (): Promise<EngineResult> => ({ ok: true, message: 'SHOULD NOT BE USED', events: [] }),
    );
    const { tools } = createDmTools(engine, { interactiveRoll });
    const rollDice = findRollDice(tools);

    const result: any = await rollDice.handler({ expr: 'd6', reason: 'goblin attack', roller: 'dm' }, undefined);

    expect(interactiveRoll).not.toHaveBeenCalled();
    expect(engineSpy).toHaveBeenCalledWith('d6', undefined, 'goblin attack', undefined);
    expect(textOf(result)).not.toBe('SHOULD NOT BE USED');
  });

  it('does NOT use the interactive hook when roller is omitted entirely, even though a hook is registered', async () => {
    const engine = new Engine(makeState());
    const interactiveRoll = vi.fn(
      async (): Promise<EngineResult> => ({ ok: true, message: 'SHOULD NOT BE USED', events: [] }),
    );
    const { tools } = createDmTools(engine, { interactiveRoll });
    const rollDice = findRollDice(tools);

    const result: any = await rollDice.handler({ expr: 'd6', reason: 'falling rubble' }, undefined);

    expect(interactiveRoll).not.toHaveBeenCalled();
    expect(textOf(result)).not.toBe('SHOULD NOT BE USED');
  });

  it('the fallback (instant) path still honors dc in the result message when provided', async () => {
    const engine = new Engine(makeState());
    const { tools } = createDmTools(engine);
    const rollDice = findRollDice(tools);

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.99); // near-certain success vs a low dc
    let result: any;
    try {
      result = await rollDice.handler({ expr: 'd20', reason: 'easy check', dc: 3, roller: 'player' }, undefined);
    } finally {
      randomSpy.mockRestore();
    }

    expect(textOf(result)).toContain('vs DC 3');
  });

  it('passes an undefined dc through to interactiveRoll when the DM omits it', async () => {
    const engine = new Engine(makeState());
    const interactiveRoll = vi.fn(
      async (req: InteractiveRollRequest): Promise<EngineResult> => ({
        ok: true,
        message: `got dc=${req.dc}`,
        events: [],
      }),
    );
    const { tools } = createDmTools(engine, { interactiveRoll });
    const rollDice = findRollDice(tools);

    const result: any = await rollDice.handler({ expr: 'd20', reason: 'a whim', roller: 'player' }, undefined);

    expect(interactiveRoll).toHaveBeenCalledWith({ expr: 'd20', mode: undefined, reason: 'a whim', dc: undefined });
    expect(textOf(result)).toBe('got dc=undefined');
  });

  it('surfaces an ERROR-flagged CallToolResult when the interactive hook resolves ok:false', async () => {
    const engine = new Engine(makeState());
    const interactiveRoll = vi.fn(async (): Promise<EngineResult> => ({ ok: false, error: 'no luck left' }));
    const { tools } = createDmTools(engine, { interactiveRoll });
    const rollDice = findRollDice(tools);

    const result: any = await rollDice.handler({ expr: 'd20', reason: 'test', roller: 'player' }, undefined);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('ERROR');
    expect(textOf(result)).toContain('no luck left');
  });

  it("schema instructs a short 3-6 word reason label, never a full sentence (bug fix: a sentence-length reason pushed the roll result off screen)", () => {
    const engine = new Engine(makeState());
    const { tools } = createDmTools(engine);
    const rollDice = findRollDice(tools);

    const reasonSchema = (rollDice.inputSchema as any).reason;
    expect(reasonSchema.description).toContain('3-6 words');
    expect(reasonSchema.description.toLowerCase()).toContain('never a full sentence');
  });
});
