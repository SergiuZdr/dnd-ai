import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CLASS_PRESETS,
  RACES,
  THEMES,
  BACKGROUNDS,
  STANDARD_ARRAY,
  assignStats,
  applyRaceBonuses,
  roll4d6DropLowest,
  createNewCampaign,
  createNewHero,
} from '../src/game/newCampaign';
import { abilityMod } from '../src/game/state';
import type { GameState } from '../src/game/state';

function sequenceRng(values: number[]): () => number {
  let i = 0;
  return () => {
    const value = i < values.length ? values[i] : values[values.length - 1];
    i += 1;
    return value;
  };
}

describe('assignStats', () => {
  it('sorts values descending and assigns in priority order', () => {
    const stats = assignStats([8, 15, 10, 14, 12, 13], ['str', 'dex', 'con', 'int', 'wis', 'cha']);
    // sorted desc: 15,14,13,12,10,8
    expect(stats).toEqual({ str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 });
  });

  it('respects an arbitrary priority order, not just the canonical stat order', () => {
    const stats = assignStats(STANDARD_ARRAY, ['cha', 'dex', 'int', 'str', 'con', 'wis']);
    // STANDARD_ARRAY is already sorted desc: 15,14,13,12,10,8
    expect(stats).toEqual({ cha: 15, dex: 14, int: 13, str: 12, con: 10, wis: 8 });
  });

  it('does not mutate the input values array', () => {
    const values = [8, 15, 10, 14, 12, 13];
    const copy = [...values];
    assignStats(values, ['str', 'dex', 'con', 'int', 'wis', 'cha']);
    expect(values).toEqual(copy);
  });
});

describe('roll4d6DropLowest', () => {
  it('drops the lowest of 4 stubbed dice and sums the rest', () => {
    // rng values map to faces via floor(rng*6)+1: 0->1, 1/6->2, 2/6->3, 3/6->4
    const rng = sequenceRng([0, 1 / 6, 2 / 6, 3 / 6]); // faces [1,2,3,4]
    expect(roll4d6DropLowest(rng)).toBe(2 + 3 + 4); // drop the 1
  });

  it('drops only a single die when the lowest value repeats', () => {
    // faces [1,1,5,6] -> drop exactly one of the two 1s
    const rng = sequenceRng([0, 0, 4 / 6, 5 / 6]);
    expect(roll4d6DropLowest(rng)).toBe(1 + 5 + 6);
  });

  it('defaults to Math.random and always lands in [3,18]', () => {
    for (let i = 0; i < 200; i++) {
      const total = roll4d6DropLowest();
      expect(Number.isInteger(total)).toBe(true);
      expect(total).toBeGreaterThanOrEqual(3);
      expect(total).toBeLessThanOrEqual(18);
    }
  });
});

describe('CLASS_PRESETS', () => {
  it('gives every class a non-empty starter inventory', () => {
    for (const preset of CLASS_PRESETS) {
      expect(preset.starterItems.length).toBeGreaterThan(0);
    }
  });

  it('gives every class a 6-key stat priority covering each stat exactly once', () => {
    const allStats = ['cha', 'con', 'dex', 'int', 'str', 'wis'];
    for (const preset of CLASS_PRESETS) {
      expect([...preset.statPriority].sort()).toEqual(allStats);
    }
  });

  it('includes the six documented classes', () => {
    expect(CLASS_PRESETS.map((p) => p.id).sort()).toEqual(
      ['bard', 'cleric', 'fighter', 'ranger', 'rogue', 'wizard'].sort(),
    );
  });

  it('gives every class a non-empty tagline for the wizard tooltip', () => {
    for (const preset of CLASS_PRESETS) {
      expect(preset.tagline.length).toBeGreaterThan(0);
    }
  });
});

describe('RACES / THEMES', () => {
  it('lists at least the 4 documented races by name', () => {
    expect(RACES.map((r) => r.name)).toEqual(
      expect.arrayContaining(['Human', 'Elf', 'Dwarf', 'Halfling', 'Half-Orc', 'Tiefling']),
    );
  });

  it('gives every race a non-empty tooltip description and at least one stat bonus', () => {
    for (const race of RACES) {
      expect(race.description.length).toBeGreaterThan(0);
      expect(Object.keys(race.bonuses).length).toBeGreaterThan(0);
    }
  });

  it('matches the documented bonus package for each of the four anchor races', () => {
    const byName = Object.fromEntries(RACES.map((r) => [r.name, r]));
    expect(byName.Human.bonuses).toEqual({ str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 });
    expect(byName.Elf.bonuses).toEqual({ dex: 2, wis: 1 });
    expect(byName.Dwarf.bonuses).toEqual({ con: 2, str: 1 });
    expect(byName.Halfling.bonuses).toEqual({ dex: 2, cha: 1 });
  });

  it('includes classic/grim/whimsical/custom themes with matching seeds', () => {
    const byId = Object.fromEntries(THEMES.map((t) => [t.id, t]));
    expect(byId.classic.seed).toBe('classic high fantasy');
    expect(byId.grim.seed).toBe('grim dark low-fantasy');
    expect(byId.whimsical.seed).toBe('whimsical lighthearted fairytale');
    expect(byId.custom.seed).toBe('');
  });
});

describe('applyRaceBonuses', () => {
  const baseStats = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };

  it('adds the matching race bonuses on top of base stats, leaving unlisted stats untouched', () => {
    expect(applyRaceBonuses(baseStats, 'Elf')).toEqual({ str: 10, dex: 12, con: 10, int: 10, wis: 11, cha: 10 });
    expect(applyRaceBonuses(baseStats, 'Dwarf')).toEqual({ str: 11, dex: 10, con: 12, int: 10, wis: 10, cha: 10 });
  });

  it('applies +1 to every stat for Human', () => {
    expect(applyRaceBonuses(baseStats, 'Human')).toEqual({ str: 11, dex: 11, con: 11, int: 11, wis: 11, cha: 11 });
  });

  it('is a no-op for an unrecognized race name, and does not mutate the input', () => {
    const copy = { ...baseStats };
    expect(applyRaceBonuses(baseStats, 'Dragonborn')).toEqual(baseStats);
    expect(baseStats).toEqual(copy);
  });
});

describe('BACKGROUNDS', () => {
  it('lists the 5 documented backgrounds, each with a fact for the DM', () => {
    expect(BACKGROUNDS.map((b) => b.id).sort()).toEqual(
      ['acolyte', 'outlaw', 'scholar', 'soldier', 'wanderer'].sort(),
    );
    for (const background of BACKGROUNDS) {
      expect(background.fact.length).toBeGreaterThan(0);
      expect(background.description.length).toBeGreaterThan(0);
    }
  });

  it('grants exactly the documented mechanical extras', () => {
    const byId = Object.fromEntries(BACKGROUNDS.map((b) => [b.id, b]));
    expect(byId.soldier.item).toEqual({ name: 'Old Service Blade', qty: 1 });
    expect(byId.scholar.item).toBeUndefined();
    expect(byId.scholar.gold).toBeUndefined();
    expect(byId.outlaw.gold).toBe(10);
    expect(byId.acolyte.item).toEqual({ name: 'Healing Draught', qty: 1 });
    expect(byId.wanderer.item).toEqual({ name: "Traveler's Kit", qty: 1 });
  });
});

describe('createNewCampaign', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-newcampaign-'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('computes maxHp/hp/ac from the class base plus ability mods, on top of the racial bonus', () => {
    const state = createNewCampaign(
      {
        name: 'Test Campaign',
        heroName: 'Theron',
        classId: 'fighter',
        race: 'Human',
        statValues: STANDARD_ARRAY, // [15,14,13,12,10,8]
        themeSeed: 'classic high fantasy',
      },
      baseDir,
    );

    // Fighter priority str,con,dex,int,wis,cha -> base str15,con14,dex13,int12,wis10,cha8;
    // Human's +1-to-everything lands on top of that.
    expect(state.character.stats).toEqual({ str: 16, con: 15, dex: 14, int: 13, wis: 11, cha: 9 });
    const conMod = abilityMod(15);
    const dexMod = abilityMod(14);
    expect(state.character.maxHp).toBe(10 + conMod);
    expect(state.character.hp).toBe(state.character.maxHp);
    expect(state.character.ac).toBe(16 + Math.max(0, Math.min(2, dexMod)));
  });

  it('floors maxHp at 1 even when hitBase + conMod would go non-positive', () => {
    const state = createNewCampaign(
      {
        name: 'Frail',
        heroName: 'Weakling',
        // Wizard priority int,dex,con,... -> con gets the 3rd-highest value.
        classId: 'wizard',
        race: 'Halfling',
        statValues: [20, 20, -2, -2, -2, -2],
        themeSeed: 'grim dark low-fantasy',
      },
      baseDir,
    );
    expect(state.character.stats.con).toBe(-2); // abilityMod(-2) = -6; hitBase 6 + -6 = 0
    expect(state.character.maxHp).toBe(1);
    expect(state.character.hp).toBe(1);
  });

  it('clamps the AC dex bonus at +2 on the high end', () => {
    const state = createNewCampaign(
      {
        name: 'Speedy',
        heroName: 'Zippy',
        // Fighter priority str,con,dex,... -> dex gets the 3rd-highest value.
        classId: 'fighter',
        race: 'Elf',
        statValues: [25, 25, 20, 8, 8, 8],
        themeSeed: 'classic high fantasy',
      },
      baseDir,
    );
    // base dex 20 + Elf's +2 DEX = 22; abilityMod(22) = +6, would blow way past the +2 cap either way.
    expect(state.character.stats.dex).toBe(22);
    expect(state.character.ac).toBe(16 + 2);
  });

  it('clamps the AC dex bonus at 0 on the low end (never a penalty)', () => {
    const state = createNewCampaign(
      {
        name: 'Clumsy',
        heroName: 'Oaf',
        classId: 'fighter',
        race: 'Half-Orc',
        statValues: [8, 8, 1, 1, 1, 1],
        themeSeed: 'grim dark low-fantasy',
      },
      baseDir,
    );
    expect(state.character.stats.dex).toBe(1); // abilityMod(1) = -5, must not subtract from AC
    expect(state.character.ac).toBe(16 + 0);
  });

  it('defaults contentRating to PG-13, gold to 15, level 1, xp 0, location Unknown', () => {
    const state = createNewCampaign(
      {
        name: 'Defaults',
        heroName: 'Hero',
        classId: 'rogue',
        race: 'Elf',
        statValues: STANDARD_ARRAY,
        themeSeed: 'classic high fantasy',
      },
      baseDir,
    );
    expect(state.campaign.contentRating).toBe('PG-13');
    expect(state.character.gold).toBe(15);
    expect(state.character.level).toBe(1);
    expect(state.character.xp).toBe(0);
    expect(state.world.location).toBe('Unknown');
    expect(state.chronicle.storySoFar).toBe('');
    expect(state.chronicle.chapters).toEqual([]);
  });

  it('honors an explicit contentRating override', () => {
    const state = createNewCampaign(
      {
        name: 'R Rated',
        heroName: 'Hero',
        classId: 'ranger',
        race: 'Tiefling',
        statValues: STANDARD_ARRAY,
        themeSeed: 'grim dark low-fantasy',
        contentRating: 'R',
      },
      baseDir,
    );
    expect(state.campaign.contentRating).toBe('R');
  });

  it('copies starter items rather than sharing the preset array/object references', () => {
    const state = createNewCampaign(
      {
        name: 'Copy Check',
        heroName: 'Hero',
        classId: 'cleric',
        race: 'Dwarf',
        statValues: STANDARD_ARRAY,
        themeSeed: 'classic high fantasy',
      },
      baseDir,
    );
    state.character.inventory[0].qty = 999;
    const preset = CLASS_PRESETS.find((p) => p.id === 'cleric')!;
    expect(preset.starterItems[0].qty).not.toBe(999);
  });

  it('does not write anything to disk', () => {
    createNewCampaign(
      {
        name: 'No Write',
        heroName: 'Hero',
        classId: 'bard',
        race: 'Tiefling',
        statValues: STANDARD_ARRAY,
        themeSeed: 'whimsical lighthearted fairytale',
      },
      baseDir,
    );
    expect(fs.readdirSync(baseDir)).toEqual([]);
  });

  it('slugifies the campaign name and appends -2, -3, ... on collisions', () => {
    fs.mkdirSync(path.join(baseDir, 'my-campaign'), { recursive: true });
    const state1 = createNewCampaign(
      {
        name: 'My Campaign',
        heroName: 'Hero',
        classId: 'ranger',
        race: 'Human',
        statValues: STANDARD_ARRAY,
        themeSeed: 'classic high fantasy',
      },
      baseDir,
    );
    expect(state1.campaign.slug).toBe('my-campaign-2');

    fs.mkdirSync(path.join(baseDir, 'my-campaign-2'), { recursive: true });
    const state2 = createNewCampaign(
      {
        name: 'My Campaign',
        heroName: 'Hero',
        classId: 'ranger',
        race: 'Human',
        statValues: STANDARD_ARRAY,
        themeSeed: 'classic high fantasy',
      },
      baseDir,
    );
    expect(state2.campaign.slug).toBe('my-campaign-3');
  });

  it('throws a descriptive error for an unknown classId', () => {
    expect(() =>
      createNewCampaign(
        {
          name: 'Bad Class',
          heroName: 'Hero',
          classId: 'necromancer',
          race: 'Human',
          statValues: STANDARD_ARRAY,
          themeSeed: 'classic high fantasy',
        },
        baseDir,
      ),
    ).toThrow('necromancer');
  });

  it('leaves background/backgroundFact empty and gold at the base 15 when no backgroundId is given', () => {
    const state = createNewCampaign(
      {
        name: 'No Background',
        heroName: 'Hero',
        classId: 'fighter',
        race: 'Human',
        statValues: STANDARD_ARRAY,
        themeSeed: 'classic high fantasy',
      },
      baseDir,
    );
    expect(state.character.background).toBe('');
    expect(state.character.backgroundFact).toBe('');
    expect(state.character.gold).toBe(15);
  });

  it('grants a background item on top of the class kit, and records the name + fact', () => {
    const state = createNewCampaign(
      {
        name: 'Blade Bearer',
        heroName: 'Marta',
        classId: 'wizard', // starter kit has no weapon -- makes the granted item unambiguous
        race: 'Human',
        backgroundId: 'soldier',
        statValues: STANDARD_ARRAY,
        themeSeed: 'classic high fantasy',
      },
      baseDir,
    );
    expect(state.character.background).toBe('Soldier');
    expect(state.character.backgroundFact.length).toBeGreaterThan(0);
    expect(state.character.inventory).toEqual(
      expect.arrayContaining([{ name: 'Old Service Blade', qty: 1 }]),
    );
    // Class starter items are still present alongside the granted one.
    expect(state.character.inventory.length).toBe(3); // Staff, Spellbook, Old Service Blade
  });

  it('grants background gold on top of the base 15', () => {
    const state = createNewCampaign(
      {
        name: 'Ill Gotten',
        heroName: 'Rook',
        classId: 'rogue',
        race: 'Human',
        backgroundId: 'outlaw',
        statValues: STANDARD_ARRAY,
        themeSeed: 'grim dark low-fantasy',
      },
      baseDir,
    );
    expect(state.character.gold).toBe(25); // 15 base + 10 outlaw
  });

  it('grants a fact-only background (no item, no gold) without touching inventory/gold', () => {
    const state = createNewCampaign(
      {
        name: 'Book Learned',
        heroName: 'Sage',
        classId: 'wizard',
        race: 'Human',
        backgroundId: 'scholar',
        statValues: STANDARD_ARRAY,
        themeSeed: 'classic high fantasy',
      },
      baseDir,
    );
    expect(state.character.background).toBe('Scholar');
    expect(state.character.backgroundFact.length).toBeGreaterThan(0);
    expect(state.character.gold).toBe(15);
    expect(state.character.inventory.length).toBe(2); // just the wizard's Staff + Spellbook
  });

  it('every new character starts with 1 luck', () => {
    const state = createNewCampaign(
      {
        name: 'Lucky Start',
        heroName: 'Hero',
        classId: 'fighter',
        race: 'Human',
        statValues: STANDARD_ARRAY,
        themeSeed: 'classic high fantasy',
      },
      baseDir,
    );
    expect(state.character.luck).toBe(1);
  });
});

describe('createNewHero', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-newhero-'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  function makeExisting(): GameState {
    return {
      campaign: {
        slug: 'veteran-world',
        name: 'Veteran World',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        contentRating: 'R',
      },
      character: {
        name: 'Fallen Hero',
        className: 'Fighter',
        race: 'Human',
        background: 'Soldier',
        backgroundFact: 'served as a soldier before taking up adventuring',
        level: 5,
        xp: 6500,
        hp: 0,
        maxHp: 40,
        ac: 17,
        stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
        gold: 200,
        inventory: [{ name: 'Sword', qty: 1 }],
        luck: 3,
      },
      world: {
        theme: 'grim dark low-fantasy',
        location: 'The Sunken Crypt',
        npcs: [{ name: 'Old Marrow', disposition: 'friendly', status: 'alive', facts: [] }],
        quests: [{ title: 'Find the Amulet', status: 'active', notes: [] }],
        facts: ['The king is missing.'],
      },
      chronicle: {
        storySoFar: 'A long tale.',
        chapters: [{ summary: 'Chapter 1', endedAtExchange: 10 }],
        lastSummarizedIndex: 10,
      },
    };
  }

  it('keeps the same campaign, world, and chronicle but builds a fresh level-1 character', () => {
    const existing = makeExisting();
    const result = createNewHero(existing, {
      heroName: 'Nyra',
      classId: 'wizard',
      race: 'Elf',
      statValues: STANDARD_ARRAY,
    });

    expect(result.campaign).toBe(existing.campaign);
    expect(result.world).toBe(existing.world);
    expect(result.chronicle).toBe(existing.chronicle);

    expect(result.character.name).toBe('Nyra');
    expect(result.character.race).toBe('Elf');
    expect(result.character.className).toBe('Wizard');
    expect(result.character.level).toBe(1);
    expect(result.character.xp).toBe(0);
    expect(result.character.gold).toBe(15);
    expect(result.character.hp).toBe(result.character.maxHp);
    expect(result.character.inventory.length).toBeGreaterThan(0);
  });

  it('computes the character exactly as createNewCampaign would for the same class/race/stats', () => {
    const existing = makeExisting();
    const fromHero = createNewHero(existing, {
      heroName: 'Theron',
      classId: 'fighter',
      race: 'Human',
      statValues: STANDARD_ARRAY,
    });
    const fromCampaign = createNewCampaign(
      {
        name: 'Ignored',
        heroName: 'Theron',
        classId: 'fighter',
        race: 'Human',
        statValues: STANDARD_ARRAY,
        themeSeed: 'irrelevant here',
      },
      baseDir,
    );
    expect(fromHero.character).toEqual(fromCampaign.character);
  });

  it('throws a descriptive error for an unknown classId', () => {
    const existing = makeExisting();
    expect(() =>
      createNewHero(existing, { heroName: 'X', classId: 'necromancer', race: 'Human', statValues: STANDARD_ARRAY }),
    ).toThrow('necromancer');
  });

  it('does not mutate the existing state', () => {
    const existing = makeExisting();
    const before = JSON.parse(JSON.stringify(existing));
    createNewHero(existing, { heroName: 'X', classId: 'rogue', race: 'Halfling', statValues: STANDARD_ARRAY });
    expect(existing).toEqual(before);
  });
});
