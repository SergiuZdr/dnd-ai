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
      { name: 'Rations', qty: 5 },
    ],
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
  },
];

export const RACES: string[] = ['Human', 'Elf', 'Dwarf', 'Halfling', 'Half-Orc', 'Tiefling'];

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

/** Shared by createNewCampaign and createNewHero: a fresh level-1 character from a class preset + wizard answers. */
function buildCharacter(preset: ClassPreset, heroName: string, race: string, statValues: number[]): Character {
  const stats = assignStats(statValues, preset.statPriority);
  const maxHp = Math.max(1, preset.hitBase + abilityMod(stats.con));
  const ac = preset.acBase + Math.max(0, Math.min(2, abilityMod(stats.dex)));
  return {
    name: heroName,
    className: preset.name,
    race,
    level: 1,
    xp: 0,
    hp: maxHp,
    maxHp,
    ac,
    stats,
    gold: 15,
    inventory: preset.starterItems.map((item) => ({ ...item })),
  };
}

export interface NewCampaignInput {
  name: string;
  heroName: string;
  classId: string;
  race: string;
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
    character: buildCharacter(preset, input.heroName, input.race, input.statValues),
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

  return {
    campaign: existing.campaign,
    character: buildCharacter(preset, input.heroName, input.race, input.statValues),
    world: existing.world,
    chronicle: existing.chronicle,
  };
}
