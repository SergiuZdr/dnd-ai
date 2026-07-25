// Acceptance criterion: toolSchema emits exactly 11 OpenAI function schemas
// whose names + required fields match createDmTools().tools -- derived FROM
// the same zod shapes the Claude backend's MCP server uses, so the two can
// never silently drift apart (PR-6).

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Engine } from '../src/game/engine';
import type { GameState } from '../src/game/state';
import { createDmTools } from '../src/ai/tools';
import { toolsToOpenAiSchemas, toolToOpenAiSchema } from '../src/ai/toolSchema';

function makeState(): GameState {
  return {
    campaign: {
      slug: 'toolschema-test',
      name: 'ToolSchema Test',
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

const EXPECTED_TOOL_NAMES = [
  'roll_dice',
  'apply_damage',
  'heal',
  'award_xp',
  'modify_gold',
  'add_item',
  'remove_item',
  'upsert_quest',
  'upsert_npc',
  'set_location',
  'record_fact',
];

describe('toolsToOpenAiSchemas', () => {
  it('emits exactly 11 schemas whose names match createDmTools().tools exactly (same order, same set)', () => {
    const engine = new Engine(makeState());
    const { tools } = createDmTools(engine);

    expect(tools).toHaveLength(11);
    expect(tools.map((t) => t.name)).toEqual(EXPECTED_TOOL_NAMES);

    const schemas = toolsToOpenAiSchemas(tools);
    expect(schemas).toHaveLength(11);
    expect(schemas.map((s) => s.function.name)).toEqual(tools.map((t) => t.name));
  });

  it('every schema is a well-formed OpenAI function-tool entry (type, name, description, object parameters)', () => {
    const engine = new Engine(makeState());
    const { tools } = createDmTools(engine);
    const schemas = toolsToOpenAiSchemas(tools);

    for (const schema of schemas) {
      expect(schema.type).toBe('function');
      expect(typeof schema.function.name).toBe('string');
      expect(schema.function.name.length).toBeGreaterThan(0);
      expect(typeof schema.function.description).toBe('string');
      expect(schema.function.description.length).toBeGreaterThan(0);
      expect(schema.function.parameters.type).toBe('object');
      expect(schema.function.parameters).not.toHaveProperty('$schema');
    }
  });

  it("required fields in each generated schema match exactly the tool's non-optional zod fields", () => {
    const engine = new Engine(makeState());
    const { tools } = createDmTools(engine);

    for (const tool of tools) {
      const schema = toolToOpenAiSchema(tool);
      const expectedRequired = Object.entries(tool.inputSchema as Record<string, z.ZodTypeAny>)
        .filter(([, fieldSchema]) => !fieldSchema.isOptional())
        .map(([key]) => key)
        .sort();
      const actualRequired = ((schema.function.parameters.required as string[] | undefined) ?? []).slice().sort();
      expect(actualRequired).toEqual(expectedRequired);
    }
  });

  it('roll_dice schema in particular requires expr + reason but not mode/dc/roller', () => {
    const engine = new Engine(makeState());
    const { tools } = createDmTools(engine);
    const rollDice = tools.find((t) => t.name === 'roll_dice');
    if (!rollDice) throw new Error('roll_dice not found');
    const schema = toolToOpenAiSchema(rollDice);
    expect((schema.function.parameters.required as string[]).sort()).toEqual(['expr', 'reason']);
    expect(Object.keys(schema.function.parameters.properties as Record<string, unknown>).sort()).toEqual(
      ['dc', 'expr', 'mode', 'reason', 'roller'].sort(),
    );
  });
});
