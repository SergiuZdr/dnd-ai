// PR-7's acceptance criteria: the argument validate-and-repair layer turns
// the spike's observed malformations (a JSON-Schema-shaped {"type","value"}
// wrapper, a numeric string where a number is expected) into valid tool
// call args, drops unknown keys, and turns genuinely unrepairable args into
// an `{ ok: false, error }` result -- NEVER a throw -- so the caller can
// hand the model an `ERROR: ...` tool result and let it self-correct.

import { describe, it, expect } from 'vitest';
import { Engine } from '../../src/game/engine';
import type { GameState } from '../../src/game/state';
import { createDmTools } from '../../src/ai/tools';
import { repairAndValidateArgs } from '../../src/ai/argRepair';

function makeState(): GameState {
  return {
    campaign: {
      slug: 'argrepair-test',
      name: 'ArgRepair Test',
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

function findTool(tools: ReturnType<typeof createDmTools>['tools'], name: string) {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`${name} tool not found`);
  return found;
}

describe('repairAndValidateArgs', () => {
  it("unwraps a JSON-Schema-shaped dc ({type:'integer',value:15}) into a valid roll_dice call (the spike's exact observed malformation)", () => {
    const engine = new Engine(makeState());
    const { tools } = createDmTools(engine);
    const rollDice = findTool(tools, 'roll_dice');

    const result = repairAndValidateArgs(rollDice, {
      dc: { type: 'integer', value: 15 },
      expr: 'd20+3',
      reason: 'x',
      roller: 'player',
    });

    expect(result).toEqual({ ok: true, args: { dc: 15, expr: 'd20+3', reason: 'x', roller: 'player' } });
  });

  it("coerces a numeric string amount ('25') into a number for award_xp", () => {
    const engine = new Engine(makeState());
    const { tools } = createDmTools(engine);
    const awardXp = findTool(tools, 'award_xp');

    const result = repairAndValidateArgs(awardXp, { amount: '25' });

    expect(result).toEqual({ ok: true, args: { amount: 25 } });
  });

  it('unwraps a JSON-Schema-shaped string value too (not just numbers)', () => {
    const engine = new Engine(makeState());
    const { tools } = createDmTools(engine);
    const heal = findTool(tools, 'heal');

    const result = repairAndValidateArgs(heal, {
      amount: { type: 'integer', value: 4 },
      reason: { type: 'string', value: 'drank a potion' },
    });

    expect(result).toEqual({ ok: true, args: { amount: 4, reason: 'drank a potion' } });
  });

  it('drops unknown/extra keys the model hallucinated, keeping the call valid', () => {
    const engine = new Engine(makeState());
    const { tools } = createDmTools(engine);
    const modifyGold = findTool(tools, 'modify_gold');

    const result = repairAndValidateArgs(modifyGold, { delta: 10, reason: 'sold loot', confidence: 0.9, extra: 'noise' });

    expect(result).toEqual({ ok: true, args: { delta: 10, reason: 'sold loot' } });
  });

  it('passes already-well-formed args through unchanged', () => {
    const engine = new Engine(makeState());
    const { tools } = createDmTools(engine);
    const addItem = findTool(tools, 'add_item');

    const result = repairAndValidateArgs(addItem, { name: 'Silver Key', qty: 2 });

    expect(result).toEqual({ ok: true, args: { name: 'Silver Key', qty: 2 } });
  });

  it('returns ok:false (never throws) when a required field is missing entirely and cannot be repaired', () => {
    const engine = new Engine(makeState());
    const { tools } = createDmTools(engine);
    const rollDice = findTool(tools, 'roll_dice');

    let result: ReturnType<typeof repairAndValidateArgs> | undefined;
    expect(() => {
      result = repairAndValidateArgs(rollDice, { expr: 'd20+3' }); // missing required `reason`
    }).not.toThrow();

    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
      expect(result.error).toContain('reason');
    }
  });

  it('returns ok:false when an enum field has an invalid value', () => {
    const engine = new Engine(makeState());
    const { tools } = createDmTools(engine);
    const upsertQuest = findTool(tools, 'upsert_quest');

    const result = repairAndValidateArgs(upsertQuest, { title: 'Clear the Crypt', status: 'in_progress' });

    expect(result.ok).toBe(false);
  });

  it('returns ok:false (never throws) when the arguments are not a JSON object at all (e.g. a bare string or array)', () => {
    const engine = new Engine(makeState());
    const { tools } = createDmTools(engine);
    const heal = findTool(tools, 'heal');

    expect(() => repairAndValidateArgs(heal, 'not an object')).not.toThrow();
    expect(repairAndValidateArgs(heal, 'not an object').ok).toBe(false);
    expect(repairAndValidateArgs(heal, [1, 2, 3]).ok).toBe(false);
    expect(repairAndValidateArgs(heal, null).ok).toBe(false);
  });

  it('does not coerce a non-numeric string into a number (stays unrepairable)', () => {
    const engine = new Engine(makeState());
    const { tools } = createDmTools(engine);
    const awardXp = findTool(tools, 'award_xp');

    const result = repairAndValidateArgs(awardXp, { amount: 'a lot' });

    expect(result.ok).toBe(false);
  });
});
