// Character-creation presets and pure math: class/race/theme catalogs, stat
// assignment, ability rolling, and the derived hp/ac formulas. The only I/O is
// a read-only fs check to dodge slug collisions — createNewCampaign never
// writes to disk itself (the caller decides when/if to saveGame()).

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Character, GameState, Item, Stats } from './state';
import { abilityMod } from './state';
import { slugify } from './saves';

export interface ClassPreset {
  id: string;
  name: string;
  hitBase: number;
  acBase: number;
  /** All 6 stat keys, most-important first — assignStats gives priority[0] the highest rolled value. */
  statPriority: (keyof Stats)[];
  starterItems: Item[];
  /** One-line playstyle blurb for the wizard tooltip, e.g. "front-line weapon master". Key stat/hit die/kit are derived from the fields above. */
  tagline: string;
}

export const CLASS_PRESETS: ClassPreset[] = [
  {
    id: 'fighter',
    name: 'Fighter',
    hitBase: 10,
    acBase: 16,
    statPriority: ['str', 'con', 'dex', 'int', 'wis', 'cha'],
    starterItems: [
      { name: 'Sword', qty: 1 },
      { name: 'Shield', qty: 1 },
      { name: 'Chainmail', qty: 1 },
      { name: 'Rations', qty: 5 },
    ],
    tagline: 'front-line weapon master',
  },
  {
    id: 'rogue',
    name: 'Rogue',
    hitBase: 8,
    acBase: 14,
    statPriority: ['dex', 'cha', 'int', 'str', 'con', 'wis'],
    starterItems: [
      { name: 'Dagger', qty: 2 },
      { name: "Thieves' Tools", qty: 1 },
    ],
    tagline: 'quick, cunning, and deadly from the shadows',
  },
  {
    id: 'wizard',
    name: 'Wizard',
    hitBase: 6,
    acBase: 12,
    statPriority: ['int', 'dex', 'con', 'str', 'wis', 'cha'],
    starterItems: [
      { name: 'Staff', qty: 1 },
      { name: 'Spellbook', qty: 1 },
    ],
    tagline: 'a scholar of the arcane who bends reality through careful study',
  },
  {
    id: 'cleric',
    name: 'Cleric',
    hitBase: 8,
    acBase: 15,
    statPriority: ['wis', 'con', 'str', 'dex', 'int', 'cha'],
    starterItems: [
      { name: 'Mace', qty: 1 },
      { name: 'Holy Symbol', qty: 1 },
    ],
    tagline: 'a divine conduit who heals allies and smites the wicked',
  },
  {
    id: 'ranger',
    name: 'Ranger',
    hitBase: 10,
    acBase: 14,
    statPriority: ['dex', 'wis', 'con', 'str', 'int', 'cha'],
    starterItems: [
      { name: 'Bow', qty: 1 },
      { name: 'Arrows', qty: 20 },
      { name: 'Shortsword', qty: 1 },
    ],
    tagline: 'a sharp-eyed hunter equally at home in the wild or in a fight',
  },
  {
    id: 'bard',
    name: 'Bard',
    hitBase: 8,
    acBase: 13,
    statPriority: ['cha', 'dex', 'con', 'str', 'int', 'wis'],
    starterItems: [
      { name: 'Rapier', qty: 1 },
      { name: 'Lute', qty: 1 },
    ],
    tagline: 'a charismatic performer whose words and music work magic',
  },
];

export interface RacePreset {
  id: string;
  name: string;
  /** Tooltip text stating the bonus, e.g. "Graceful and keen-eyed. +2 DEX, +1 WIS." */
  description: string;
  /** Flat bonuses applied on top of rolled/array stats at character creation — see applyRaceBonuses. */
  bonuses: Partial<Stats>;
}

export const RACES: RacePreset[] = [
  {
    id: 'human',
    name: 'Human',
    description: 'Adaptable and driven. +1 to every ability score.',
    bonuses: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 },
  },
  {
    id: 'elf',
    name: 'Elf',
    description: 'Graceful and keen-eyed. +2 DEX, +1 WIS.',
    bonuses: { dex: 2, wis: 1 },
  },
  {
    id: 'dwarf',
    name: 'Dwarf',
    description: 'Stout and hardy. +2 CON, +1 STR.',
    bonuses: { con: 2, str: 1 },
  },
  {
    id: 'halfling',
    name: 'Halfling',
    description: 'Lucky and nimble. +2 DEX, +1 CHA.',
    bonuses: { dex: 2, cha: 1 },
  },
  {
    id: 'half-orc',
    name: 'Half-Orc',
    description: 'Powerful and relentless. +2 STR, +1 CON.',
    bonuses: { str: 2, con: 1 },
  },
  {
    id: 'tiefling',
    name: 'Tiefling',
    description: 'Infernal blood runs in their veins. +2 CHA, +1 INT.',
    bonuses: { cha: 2, int: 1 },
  },
];

/** Applies a race's flat stat bonuses on top of the given (rolled/array-assigned) base stats. Unknown race name is a no-op. */
export function applyRaceBonuses(stats: Stats, raceName: string): Stats {
  const race = RACES.find((r) => r.name === raceName);
  if (!race) return { ...stats };
  const result = { ...stats };
  for (const key of Object.keys(race.bonuses) as (keyof Stats)[]) {
    result[key] = result[key] + (race.bonuses[key] ?? 0);
  }
  return result;
}

export interface BackgroundPreset {
  id: string;
  name: string;
  /** Tooltip text stating the mechanical grant + flavor. */
  description: string;
  /** Extra starter item granted on top of the class kit, if any. */
  item?: Item;
  /** Gold granted on top of the base starting gold, if any. */
  gold?: number;
  /** The DM-facing fact recorded on the character (Character.backgroundFact). */
  fact: string;
}

export const BACKGROUNDS: BackgroundPreset[] = [
  {
    id: 'soldier',
    name: 'Soldier',
    description: 'A blooded veteran of some war. Grants an old service blade.',
    item: { name: 'Old Service Blade', qty: 1 },
    fact: 'served as a soldier before taking up adventuring, and still carries an old service blade from that time',
  },
  {
    id: 'scholar',
    name: 'Scholar',
    description: 'Trained in lore and old books. Starts knowing a lore hook worth investigating.',
    fact: 'trained as a scholar and knows of a lore hook worth investigating',
  },
  {
    id: 'outlaw',
    name: 'Outlaw',
    description: 'Lived outside the law. Grants 10 extra starting gold from old ill-gotten gains.',
    gold: 10,
    fact: 'has a past as an outlaw, with enemies or debts that may resurface',
  },
  {
    id: 'acolyte',
    name: 'Acolyte',
    description: 'Raised in service of a temple. Grants a healing draught.',
    item: { name: 'Healing Draught', qty: 1 },
    fact: 'was raised as an acolyte in service of a temple',
  },
  {
    id: 'wanderer',
    name: 'Wanderer',
    description: "Never settled anywhere long. Grants a traveler's kit.",
    item: { name: "Traveler's Kit", qty: 1 },
    fact: 'has wandered many roads before this one and rarely stays anywhere for long',
  },
];

export interface ThemePreset {
  id: string;
  label: string;
  /** World-theme seed text fed into the DM system/opening prompt; '' for custom until the player fills it in. */
  seed: string;
}

export const THEMES: ThemePreset[] = [
  { id: 'classic', label: 'Classic High Fantasy', seed: 'classic high fantasy' },
  { id: 'grim', label: 'Grim Dark Low-Fantasy', seed: 'grim dark low-fantasy' },
  { id: 'whimsical', label: 'Whimsical Lighthearted Fairytale', seed: 'whimsical lighthearted fairytale' },
  { id: 'custom', label: 'Custom...', seed: '' },
];

export const STANDARD_ARRAY: number[] = [15, 14, 13, 12, 10, 8];

/**
 * Sorts `values` descending and assigns them to stats in `priority` order:
 * priority[0] gets the highest value, priority[1] the next, and so on.
 * `priority` must list all 6 stat keys exactly once.
 */
export function assignStats(values: number[], priority: (keyof Stats)[]): Stats {
  const sorted = [...values].sort((a, b) => b - a);
  const stats = {} as Stats;
  priority.forEach((key, i) => {
    stats[key] = sorted[i];
  });
  return stats;
}

/** Rolls 4d6, drops the single lowest die, and sums the remaining 3. */
export function roll4d6DropLowest(rng: () => number = Math.random): number {
  const faces: number[] = [];
  for (let i = 0; i < 4; i++) {
    faces.push(Math.floor(rng() * 6) + 1);
  }
  faces.sort((a, b) => a - b);
  return faces.slice(1).reduce((sum, face) => sum + face, 0);
}

function defaultBaseDir(): string {
  return path.join(process.cwd(), 'saves');
}

/** Returns slugify(name), or that slug with -2, -3, ... appended until it doesn't collide with an existing save dir. */
function uniqueSlug(name: string, baseDir: string): string {
  const base = slugify(name);
  let candidate = base;
  let suffix = 2;
  while (fs.existsSync(path.join(baseDir, candidate))) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * Shared by createNewCampaign and createNewHero: a fresh level-1 character
 * from a class preset + wizard answers. Racial bonuses are applied AFTER the
 * stat-roll/array step (on top of `statValues`'s assigned base), matching the
 * wizard's "base vs final" confirm screen. `background` is optional so
 * existing callers that don't pass one still get a valid (unbranded)
 * character -- see NewCampaignInput.backgroundId.
 */
function buildCharacter(
  preset: ClassPreset,
  heroName: string,
  race: string,
  statValues: number[],
  background?: BackgroundPreset,
): Character {
  const baseStats = assignStats(statValues, preset.statPriority);
  const stats = applyRaceBonuses(baseStats, race);
  const maxHp = Math.max(1, preset.hitBase + abilityMod(stats.con));
  const ac = preset.acBase + Math.max(0, Math.min(2, abilityMod(stats.dex)));
  const inventory = preset.starterItems.map((item) => ({ ...item }));
  if (background?.item) {
    inventory.push({ ...background.item });
  }
  return {
    name: heroName,
    className: preset.name,
    race,
    background: background?.name ?? '',
    backgroundFact: background?.fact ?? '',
    level: 1,
    xp: 0,
    hp: maxHp,
    maxHp,
    ac,
    stats,
    gold: 15 + (background?.gold ?? 0),
    inventory,
    luck: 1,
  };
}

export interface NewCampaignInput {
  name: string;
  heroName: string;
  classId: string;
  race: string;
  /** BackgroundPreset id (see BACKGROUNDS). Omitted or unrecognized -> no background grant. */
  backgroundId?: string;
  statValues: number[];
  themeSeed: string;
  contentRating?: 'PG-13' | 'R';
}

/**
 * Builds a brand-new GameState from wizard answers. Pure aside from a
 * read-only fs check for slug uniqueness — does NOT write to disk; the caller
 * is expected to saveGame() it.
 */
export function createNewCampaign(input: NewCampaignInput, baseDir: string = defaultBaseDir()): GameState {
  const preset = CLASS_PRESETS.find((p) => p.id === input.classId);
  if (!preset) {
    throw new Error(`Unknown class id: "${input.classId}"`);
  }
  const background = BACKGROUNDS.find((b) => b.id === input.backgroundId);

  const slug = uniqueSlug(input.name, baseDir);
  const ts = new Date().toISOString();

  return {
    campaign: {
      slug,
      name: input.name,
      createdAt: ts,
      updatedAt: ts,
      contentRating: input.contentRating ?? 'PG-13',
    },
    character: buildCharacter(preset, input.heroName, input.race, input.statValues, background),
    world: {
      theme: input.themeSeed,
      location: 'Unknown',
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

export interface NewHeroInput {
  heroName: string;
  classId: string;
  race: string;
  /** BackgroundPreset id (see BACKGROUNDS). Omitted or unrecognized -> no background grant. */
  backgroundId?: string;
  statValues: number[];
}

/**
 * Builds the GameState for a `/retire` reincarnation: the same campaign,
 * world, and chronicle (the world outlives its heroes) with a brand-new
 * level-1 character. Pure — does NOT write to disk or touch the transcript;
 * the caller is expected to saveGame() and append the "a new hero rises"
 * transcript note itself.
 */
export function createNewHero(existing: GameState, input: NewHeroInput): GameState {
  const preset = CLASS_PRESETS.find((p) => p.id === input.classId);
  if (!preset) {
    throw new Error(`Unknown class id: "${input.classId}"`);
  }
  const background = BACKGROUNDS.find((b) => b.id === input.backgroundId);

  return {
    campaign: existing.campaign,
    character: buildCharacter(preset, input.heroName, input.race, input.statValues, background),
    world: existing.world,
    chronicle: existing.chronicle,
  };
}
