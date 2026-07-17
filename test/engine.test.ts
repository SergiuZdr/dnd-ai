import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Engine } from '../src/game/engine';
import type { EngineResult } from '../src/game/engine';
import type { GameState } from '../src/game/state';
import { abilityMod } from '../src/game/state';

// Fixture: a level-1 character with con 14, hp 12/12, gold 10, inventory [Rope x1].
function makeState(): GameState {
  return {
    campaign: {
      slug: 'test-campaign',
      name: 'Test Campaign',
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
      inventory: [{ name: 'Rope', qty: 1 }],
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

describe('Engine', () => {
  let engine: Engine;
  let mutationCount: number;

  beforeEach(() => {
    engine = new Engine(makeState());
    mutationCount = 0;
    engine.onMutation = () => {
      mutationCount += 1;
    };
  });

  describe('rollDice', () => {
    it('never calls onMutation', () => {
      engine.rollDice('d20', 'normal', 'test roll');
      expect(mutationCount).toBe(0);
    });

    it('wraps an invalid expression into ok:false instead of throwing', () => {
      expect(() => engine.rollDice('nonsense', undefined, 'test')).not.toThrow();
      const result = engine.rollDice('nonsense', undefined, 'test');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Invalid dice expression');
    });

    it('matches the documented message shape for a simple normal roll', () => {
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.65);
      try {
        const result = engine.rollDice('d20+2', 'normal', 'attack roll');
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.message).toBe('🎲 d20+2 (attack roll) → [14]+2 = 16');
          expect(result.events).toEqual([]);
        }
      } finally {
        randomSpy.mockRestore();
      }
    });

    it('includes full attempt data for advantage/disadvantage rolls', () => {
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValueOnce(0.65).mockReturnValueOnce(0.1);
      try {
        const result = engine.rollDice('d20', 'advantage', 'saving throw');
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.message).toContain('advantage');
          expect(result.message).toContain('14');
          expect(result.message).toContain('3');
        }
      } finally {
        randomSpy.mockRestore();
      }
    });
  });

  describe('applyDamage', () => {
    it('floors hp at 0 and emits hp-zero', () => {
      const result = engine.applyDamage(1000, 'dragon breath');
      expect(result.ok).toBe(true);
      expect(engine.state.character.hp).toBe(0);
      if (result.ok) {
        expect(result.events).toContain('hp-zero');
        expect(result.message.toLowerCase()).toContain('fallen');
      }
      expect(mutationCount).toBe(1);
    });

    it('does not emit hp-zero when hp remains above 0', () => {
      const result = engine.applyDamage(1, 'graze');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.events).not.toContain('hp-zero');
      expect(engine.state.character.hp).toBe(11);
    });

    it('rejects non-integer, NaN, zero, and out-of-range amounts', () => {
      for (const bad of [NaN, 1.5, 0, -1, 1001]) {
        const result = engine.applyDamage(bad, 'x');
        expect(result.ok).toBe(false);
      }
    });
  });

  describe('heal', () => {
    it('clamps overheal at maxHp', () => {
      engine.state.character.hp = 5;
      const result = engine.heal(1000, 'potion');
      expect(result.ok).toBe(true);
      expect(engine.state.character.hp).toBe(engine.state.character.maxHp);
      expect(mutationCount).toBe(1);
    });

    it('rejects non-integer, NaN, zero, and out-of-range amounts', () => {
      for (const bad of [NaN, 1.5, 0, -1, 1001]) {
        expect(engine.heal(bad, 'x').ok).toBe(false);
      }
    });
  });

  describe('awardXp', () => {
    it('crosses a single threshold: +300 -> level 2 with a matching maxHp bump', () => {
      const conMod = abilityMod(engine.state.character.stats.con); // con 14 -> +2
      const result = engine.awardXp(300);
      expect(result.ok).toBe(true);
      expect(engine.state.character.level).toBe(2);
      expect(engine.state.character.maxHp).toBe(12 + 5 + conMod);
      expect(engine.state.character.hp).toBe(12 + 5 + conMod);
      if (result.ok) {
        expect(result.events).toContain('level-up');
        expect(result.message).toContain('reached level 2');
      }
      expect(mutationCount).toBe(1);
    });

    it('crosses multiple thresholds at once: +1000 -> level 3 with TWO hp increments', () => {
      const conMod = abilityMod(engine.state.character.stats.con);
      const perLevel = 5 + conMod;
      const result = engine.awardXp(1000);
      expect(result.ok).toBe(true);
      expect(engine.state.character.level).toBe(3);
      expect(engine.state.character.maxHp).toBe(12 + perLevel * 2);
      expect(engine.state.character.hp).toBe(12 + perLevel * 2);
    });

    it('does not level up or add events when xp is below the next threshold', () => {
      const result = engine.awardXp(1);
      expect(result.ok).toBe(true);
      expect(engine.state.character.level).toBe(1);
      if (result.ok) expect(result.events).toEqual([]);
    });

    it('rejects non-integer, NaN, zero, and out-of-range amounts', () => {
      for (const bad of [NaN, 1.5, 0, -1, 10001]) {
        expect(engine.awardXp(bad).ok).toBe(false);
      }
    });
  });

  describe('modifyGold', () => {
    it('rejects a delta that would take gold negative, stating current gold', () => {
      const result = engine.modifyGold(-11);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('10');
    });

    it('rejects a zero delta', () => {
      expect(engine.modifyGold(0).ok).toBe(false);
    });

    it('rejects non-integer deltas and magnitudes over 100000', () => {
      expect(engine.modifyGold(1.5).ok).toBe(false);
      expect(engine.modifyGold(NaN).ok).toBe(false);
      expect(engine.modifyGold(100001).ok).toBe(false);
      expect(engine.modifyGold(-100001).ok).toBe(false);
    });

    it('applies a valid positive and negative delta', () => {
      const gain = engine.modifyGold(5);
      expect(gain.ok).toBe(true);
      expect(engine.state.character.gold).toBe(15);
      const loss = engine.modifyGold(-15);
      expect(loss.ok).toBe(true);
      expect(engine.state.character.gold).toBe(0);
    });
  });

  describe('addItem / removeItem', () => {
    it('merges quantities case-insensitively', () => {
      const result = engine.addItem('rope', 2);
      expect(result.ok).toBe(true);
      expect(engine.state.character.inventory).toHaveLength(1);
      expect(engine.state.character.inventory[0].qty).toBe(3);
    });

    it('adds a new item under its own entry', () => {
      const result = engine.addItem('Torch', 3);
      expect(result.ok).toBe(true);
      expect(engine.state.character.inventory).toHaveLength(2);
    });

    it('rejects removing an item not in inventory, naming it', () => {
      const result = engine.removeItem('Sword');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Sword');
    });

    it('rejects removing more than is held, stating what is held', () => {
      const result = engine.removeItem('Rope', 3);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('1');
        expect(result.error).toContain('Rope');
      }
    });

    it('removes the entry entirely when qty reaches 0', () => {
      const result = engine.removeItem('Rope', 1);
      expect(result.ok).toBe(true);
      expect(engine.state.character.inventory).toHaveLength(0);
    });

    it('rejects invalid names and quantities', () => {
      expect(engine.addItem('', 1).ok).toBe(false);
      expect(engine.addItem('x'.repeat(61), 1).ok).toBe(false);
      for (const bad of [NaN, 1.5, 0, -1, 101]) {
        expect(engine.addItem('Thing', bad).ok).toBe(false);
        expect(engine.removeItem('Rope', bad).ok).toBe(false);
      }
    });
  });

  describe('upsertQuest', () => {
    it('creates then updates a quest by title, case-insensitively, accumulating notes', () => {
      const created = engine.upsertQuest('Find the Amulet', 'active', 'Started the search');
      expect(created.ok).toBe(true);
      expect(engine.state.world.quests).toHaveLength(1);

      const completed = engine.upsertQuest('find the amulet', 'completed', 'Found it!');
      expect(completed.ok).toBe(true);
      expect(engine.state.world.quests).toHaveLength(1);
      expect(engine.state.world.quests[0].status).toBe('completed');
      expect(engine.state.world.quests[0].notes).toEqual(['Started the search', 'Found it!']);
    });

    it('caps notes at 20, dropping the oldest', () => {
      for (let i = 0; i < 25; i++) {
        engine.upsertQuest('Long Quest', 'active', `note-${i}`);
      }
      const quest = engine.state.world.quests[0];
      expect(quest.notes).toHaveLength(20);
      expect(quest.notes[0]).toBe('note-5');
      expect(quest.notes[19]).toBe('note-24');
    });

    it('rejects an empty title', () => {
      expect(engine.upsertQuest('   ', 'active').ok).toBe(false);
    });
  });

  describe('upsertNpc', () => {
    it('creates with default neutral/alive when fields are omitted', () => {
      const result = engine.upsertNpc('Mystery Person', {});
      expect(result.ok).toBe(true);
      const npc = engine.state.world.npcs[0];
      expect(npc.disposition).toBe('neutral');
      expect(npc.status).toBe('alive');
    });

    it('updates an existing npc by name, case-insensitively', () => {
      engine.upsertNpc('Elandra', { disposition: 'friendly' });
      const result = engine.upsertNpc('elandra', { status: 'missing' });
      expect(result.ok).toBe(true);
      expect(engine.state.world.npcs).toHaveLength(1);
      expect(engine.state.world.npcs[0].disposition).toBe('friendly');
      expect(engine.state.world.npcs[0].status).toBe('missing');
    });

    it('dedupes exact facts', () => {
      engine.upsertNpc('Elandra', { fact: 'Runs the tavern' });
      engine.upsertNpc('Elandra', { fact: 'Runs the tavern' });
      expect(engine.state.world.npcs[0].facts).toEqual(['Runs the tavern']);
    });

    it('caps facts at 20 per npc, dropping the oldest', () => {
      for (let i = 0; i < 25; i++) {
        engine.upsertNpc('Elandra', { fact: `fact-${i}` });
      }
      const facts = engine.state.world.npcs[0].facts;
      expect(facts).toHaveLength(20);
      expect(facts[0]).toBe('fact-5');
      expect(facts[19]).toBe('fact-24');
    });

    it('rejects an empty name', () => {
      expect(engine.upsertNpc('  ', {}).ok).toBe(false);
    });
  });

  describe('setLocation', () => {
    it('sets a valid location', () => {
      const result = engine.setLocation('The Rusty Anchor Tavern');
      expect(result.ok).toBe(true);
      expect(engine.state.world.location).toBe('The Rusty Anchor Tavern');
    });

    it('rejects empty or overlong names', () => {
      expect(engine.setLocation('   ').ok).toBe(false);
      expect(engine.setLocation('x'.repeat(81)).ok).toBe(false);
    });
  });

  describe('recordFact', () => {
    it('dedupes exact facts', () => {
      const first = engine.recordFact('The moon is red tonight.');
      expect(first.ok).toBe(true);
      const dup = engine.recordFact('The moon is red tonight.');
      expect(dup.ok).toBe(true);
      expect(engine.state.world.facts).toHaveLength(1);
    });

    it('caps world.facts at 200, dropping the oldest', () => {
      for (let i = 0; i < 210; i++) {
        engine.recordFact(`fact number ${i}`);
      }
      expect(engine.state.world.facts).toHaveLength(200);
      expect(engine.state.world.facts[0]).toBe('fact number 10');
      expect(engine.state.world.facts[199]).toBe('fact number 209');
    });

    it('rejects empty or overlong facts', () => {
      expect(engine.recordFact('   ').ok).toBe(false);
      expect(engine.recordFact('a'.repeat(301)).ok).toBe(false);
    });
  });

  describe('onMutation contract', () => {
    it('fires exactly once per successful mutating call, and never for rollDice', () => {
      const calls: Array<() => EngineResult> = [
        () => engine.applyDamage(1, 'x'),
        () => engine.heal(1, 'x'),
        () => engine.awardXp(10),
        () => engine.modifyGold(1),
        () => engine.addItem('Torch'),
        () => engine.removeItem('Torch'),
        () => engine.upsertQuest('Q', 'active'),
        () => engine.upsertNpc('N', {}),
        () => engine.setLocation('Somewhere'),
        () => engine.recordFact('A fact.'),
      ];

      for (const call of calls) {
        mutationCount = 0;
        const result = call();
        expect(result.ok).toBe(true);
        expect(mutationCount).toBe(1);
      }

      mutationCount = 0;
      engine.rollDice('d20', 'normal', 'x');
      expect(mutationCount).toBe(0);
    });
  });
});
