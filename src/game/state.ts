// Core types + tiny constants/helpers for the game engine. No mutation logic here —
// see engine.ts for state mutations and dice.ts for rolling.

export interface Stats {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

export interface Item {
  name: string;
  qty: number;
}

export interface Character {
  name: string;
  className: string;
  race: string;
  /** Background preset name (e.g. "Soldier"), or '' if none was chosen (pre-background saves). */
  background: string;
  /** The DM-facing fact/hook granted by the background, e.g. "served as a soldier...". '' if none. */
  backgroundFact: string;
  level: number;
  xp: number;
  hp: number;
  maxHp: number;
  ac: number;
  stats: Stats;
  gold: number;
  inventory: Item[];
  /** Rerolls-with-the-better-result the player can spend on a failed DC roll. Starts at 1, +1 per level-up, capped at 3. */
  luck: number;
}

export type Disposition = 'friendly' | 'neutral' | 'hostile';
export type NpcStatus = 'alive' | 'dead' | 'missing' | 'unknown';

export interface Npc {
  name: string;
  disposition: Disposition;
  status: NpcStatus;
  facts: string[];
}

export type QuestStatus = 'active' | 'completed' | 'failed' | 'abandoned';

export interface Quest {
  title: string;
  status: QuestStatus;
  notes: string[];
}

export interface World {
  theme: string;
  location: string;
  npcs: Npc[];
  quests: Quest[];
  facts: string[];
}

export interface Chapter {
  summary: string;
  endedAtExchange: number;
}

export interface Chronicle {
  storySoFar: string;
  chapters: Chapter[];
  lastSummarizedIndex: number;
}

export interface Campaign {
  slug: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  contentRating: 'PG-13' | 'R';
  modelOverride?: string;
}

export interface GameState {
  campaign: Campaign;
  character: Character;
  world: World;
  chronicle: Chronicle;
}

// v1 -> v2: added Character.luck (default 1), Character.background/backgroundFact
// (default ''). See saves.ts's migrate* functions for the actual upgrade.
export const SCHEMA_VERSION = 2;

// 5e cumulative XP thresholds, index = level-1 (level 1 -> 0 XP ... level 20 -> 355000)
export const XP_TABLE: readonly number[] = [
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000,
  120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000,
];

export function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function levelForXp(xp: number): number {
  // Highest level whose cumulative threshold is <= xp, capped at 20.
  for (let i = XP_TABLE.length - 1; i >= 0; i--) {
    if (xp >= XP_TABLE[i]) {
      return Math.min(i + 1, 20);
    }
  }
  return 1;
}

/** XP needed to reach the next level, or null at the level-20 cap ("MAX"). */
export function nextXpThreshold(level: number): number | null {
  return level >= 20 ? null : XP_TABLE[level];
}
