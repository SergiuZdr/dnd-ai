// The deterministic game engine: every mechanical state mutation the DM (AI layer)
// can trigger goes through one of these methods. Nothing here throws across the
// public API — failures come back as { ok: false, error } so the caller (eventually
// an LLM tool result) can self-correct.

import type { GameState, QuestStatus, Disposition, NpcStatus, Npc, Quest } from './state';
import { abilityMod, levelForXp } from './state';
import type { RollMode, RollResult } from './dice';
import { roll } from './dice';

export type EngineResult =
  | { ok: true; message: string; events: string[] }
  | { ok: false; error: string };

/**
 * rollDice/rerollWithLuck return this instead of the plain EngineResult: the
 * `roll` field carries the raw RollResult alongside the formatted message so
 * a caller orchestrating the interactive player-roll flow (GameController)
 * can hold onto it for a possible luck reroll without re-rolling (which
 * would silently produce different numbers than what was already shown).
 * `reroll` is populated ONLY by rerollWithLuck -- the raw second roll, so the
 * caller can show both totals even when the original (not the reroll) was
 * the one kept. Structurally assignable to EngineResult wherever the ok
 * branch only reads message/events, so existing call sites (tools.ts, etc.)
 * need no changes.
 */
export type RollEngineResult =
  | { ok: true; message: string; events: string[]; roll: RollResult; reroll?: RollResult }
  | { ok: false; error: string };

/** +1 luck per level gained, capped at this value. */
const MAX_LUCK = 3;

function isBoundedInt(n: number, min: number, max: number): boolean {
  return Number.isInteger(n) && n >= min && n <= max;
}

/**
 * `[14, 6]+2`-style rendering of a RollResult's dice faces + modifier, with
 * no total -- exported so UI layers building their own compact layouts
 * (GameController's structured RollRevealResult) can compose it themselves
 * instead of parsing the full formatted message string.
 */
export function formatRollDetail(result: RollResult): string {
  const facesText =
    result.mode === 'normal'
      ? `[${result.chosen.join(', ')}]`
      : `attempts ${JSON.stringify(result.attempts)} -> kept [${result.chosen.join(', ')}]`;
  const modifierText =
    result.modifier > 0 ? `+${result.modifier}` : result.modifier < 0 ? `${result.modifier}` : '';
  return `${facesText}${modifierText}`;
}

/** `[14, 6]+2 = 22`-style rendering of one RollResult, shared by fresh rolls and reroll segments. */
function rollSegment(result: RollResult): string {
  return `${formatRollDetail(result)} = ${result.total}`;
}

/** ` vs DC 13 — ✓ success` / ` vs DC 13 — ✗ failure`, or '' when dc is absent. */
function dcSuffix(total: number, dc: number | undefined): string {
  if (dc === undefined) return '';
  return total >= dc ? ` vs DC ${dc} — ✓ success` : ` vs DC ${dc} — ✗ failure`;
}

function formatRollMessage(expr: string, reason: string, result: RollResult, dc: number | undefined): string {
  const modeSuffix = result.mode === 'normal' ? '' : ` [${result.mode}]`;
  return `🎲 ${expr}${modeSuffix} (${reason}) → ${rollSegment(result)}${dcSuffix(result.total, dc)}`;
}

/**
 * Combines an original roll and a luck-funded reroll into one message,
 * annotating whichever total is actually kept (the higher of the two) --
 * not always the reroll, since luck can also come up worse.
 */
function formatRerollMessage(
  expr: string,
  reason: string,
  previous: RollResult,
  rerolled: RollResult,
  dc: number | undefined,
): string {
  const modeSuffix = previous.mode === 'normal' ? '' : ` [${previous.mode}]`;
  const rerollWon = rerolled.total > previous.total;
  const combined = rerollWon
    ? `${rollSegment(previous)}, reroll ${rollSegment(rerolled)} — kept`
    : `${rollSegment(previous)} — kept, reroll ${rollSegment(rerolled)}`;
  const kept = rerollWon ? rerolled : previous;
  return `🎲 ${expr}${modeSuffix} (${reason}) → ${combined} (luck spent)${dcSuffix(kept.total, dc)}`;
}

export class Engine {
  constructor(public state: GameState) {}

  /** Called after EVERY successful (ok:true) mutation. Rolls do not mutate state and never call this. */
  onMutation?: (state: GameState) => void;

  private mutate(): void {
    this.onMutation?.(this.state);
  }

  /** dc is the target number (meet-or-beat succeeds); omit it for rolls with no pass/fail stakes. Never mutates state. */
  rollDice(expr: string, mode: RollMode | undefined, reason: string, dc?: number): RollEngineResult {
    try {
      const result = roll(expr, mode);
      return { ok: true, message: formatRollMessage(expr, reason, result, dc), events: [], roll: result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Spends 1 luck to reroll the same expr/mode as `previous` (a RollResult
   * this same Engine already produced via rollDice), keeping whichever total
   * is better. Unlike rollDice, this DOES mutate state (luck is consumed),
   * so it calls onMutation on success -- the one deliberate exception to
   * "rolls never mutate".
   */
  rerollWithLuck(previous: RollResult, reason: string, dc?: number): RollEngineResult {
    const character = this.state.character;
    if (character.luck <= 0) {
      return { ok: false, error: `${character.name} has no luck left to spend on a reroll.` };
    }
    const rerolled = roll(previous.expr, previous.mode);
    character.luck -= 1;
    const kept = rerolled.total > previous.total ? rerolled : previous;
    const message = formatRerollMessage(previous.expr, reason, previous, rerolled, dc);
    this.mutate();
    return { ok: true, message, events: [], roll: kept, reroll: rerolled };
  }

  applyDamage(amount: number, reason: string): EngineResult {
    if (!isBoundedInt(amount, 1, 1000)) {
      return { ok: false, error: `Damage amount must be an integer between 1 and 1000 (got ${amount}).` };
    }
    const character = this.state.character;
    const before = character.hp;
    character.hp = Math.max(0, character.hp - amount);
    const events: string[] = [];
    let message = `${character.name} takes ${amount} damage (${reason}): ${before} → ${character.hp} HP.`;
    if (character.hp === 0) {
      events.push('hp-zero');
      message += ` ${character.name} has fallen!`;
    }
    this.mutate();
    return { ok: true, message, events };
  }

  heal(amount: number, reason: string): EngineResult {
    if (!isBoundedInt(amount, 1, 1000)) {
      return { ok: false, error: `Heal amount must be an integer between 1 and 1000 (got ${amount}).` };
    }
    const character = this.state.character;
    const before = character.hp;
    character.hp = Math.min(character.maxHp, character.hp + amount);
    this.mutate();
    return {
      ok: true,
      message: `${character.name} heals ${amount} HP (${reason}): ${before} → ${character.hp} HP.`,
      events: [],
    };
  }

  awardXp(amount: number): EngineResult {
    if (!isBoundedInt(amount, 1, 10000)) {
      return { ok: false, error: `XP amount must be an integer between 1 and 10000 (got ${amount}).` };
    }
    const character = this.state.character;
    const beforeLevel = character.level;
    character.xp += amount;
    const newLevel = levelForXp(character.xp);
    const events: string[] = [];
    let message = `${character.name} gains ${amount} XP (total ${character.xp}).`;
    if (newLevel > beforeLevel) {
      const levelsGained = newLevel - beforeLevel;
      const perLevelGain = Math.max(1, 5 + abilityMod(character.stats.con));
      character.maxHp += perLevelGain * levelsGained;
      character.hp += perLevelGain * levelsGained;
      character.level = newLevel;
      character.luck = Math.min(MAX_LUCK, character.luck + levelsGained);
      events.push('level-up');
      message += ` ${character.name} reached level ${newLevel}!`;
    }
    this.mutate();
    return { ok: true, message, events };
  }

  modifyGold(delta: number): EngineResult {
    if (!Number.isInteger(delta)) {
      return { ok: false, error: `Gold delta must be an integer (got ${delta}).` };
    }
    if (delta === 0) {
      return { ok: false, error: 'Gold delta must not be zero.' };
    }
    if (Math.abs(delta) > 100000) {
      return { ok: false, error: `Gold delta magnitude must be at most 100000 (got ${delta}).` };
    }
    const character = this.state.character;
    const newGold = character.gold + delta;
    if (newGold < 0) {
      return {
        ok: false,
        error: `Cannot remove ${Math.abs(delta)} gold: character only has ${character.gold} gold.`,
      };
    }
    const before = character.gold;
    character.gold = newGold;
    this.mutate();
    const verb = delta > 0 ? 'gains' : 'loses';
    return {
      ok: true,
      message: `${character.name} ${verb} ${Math.abs(delta)} gold: ${before} → ${newGold}.`,
      events: [],
    };
  }

  addItem(name: string, qty: number = 1): EngineResult {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 60) {
      return { ok: false, error: `Item name must be 1-60 characters after trimming (got "${name}").` };
    }
    if (!isBoundedInt(qty, 1, 100)) {
      return { ok: false, error: `Item quantity must be an integer between 1 and 100 (got ${qty}).` };
    }
    const inventory = this.state.character.inventory;
    const existing = inventory.find((i) => i.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      existing.qty += qty;
    } else {
      inventory.push({ name: trimmed, qty });
    }
    this.mutate();
    return { ok: true, message: `Added ${qty}× ${trimmed} to inventory.`, events: [] };
  }

  removeItem(name: string, qty: number = 1): EngineResult {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 60) {
      return { ok: false, error: `Item name must be 1-60 characters after trimming (got "${name}").` };
    }
    if (!isBoundedInt(qty, 1, 100)) {
      return { ok: false, error: `Item quantity must be an integer between 1 and 100 (got ${qty}).` };
    }
    const inventory = this.state.character.inventory;
    const idx = inventory.findIndex((i) => i.name.toLowerCase() === trimmed.toLowerCase());
    if (idx === -1) {
      return { ok: false, error: `Cannot remove ${qty}× ${trimmed}: inventory has none.` };
    }
    const item = inventory[idx];
    if (qty > item.qty) {
      return { ok: false, error: `Cannot remove ${qty}× ${item.name}: inventory has only ${item.qty}.` };
    }
    item.qty -= qty;
    if (item.qty <= 0) {
      inventory.splice(idx, 1);
    }
    this.mutate();
    return { ok: true, message: `Removed ${qty}× ${item.name} from inventory.`, events: [] };
  }

  /** `reward` is trimmed and only overwrites the quest's existing reward when non-empty -- an omitted or blank reward on an update leaves whatever estimate was already recorded untouched. */
  upsertQuest(title: string, status: QuestStatus, note?: string, reward?: string): EngineResult {
    const trimmed = title.trim();
    if (trimmed.length < 1) {
      return { ok: false, error: `Quest title must not be empty (got "${title}").` };
    }
    const quests = this.state.world.quests;
    const existing = quests.find((q) => q.title.toLowerCase() === trimmed.toLowerCase());
    let quest: Quest;
    let created: boolean;
    if (existing) {
      existing.status = status;
      quest = existing;
      created = false;
    } else {
      quest = { title: trimmed, status, notes: [] };
      quests.push(quest);
      created = true;
    }
    if (note !== undefined) {
      const trimmedNote = note.trim();
      if (trimmedNote.length > 0) {
        quest.notes.push(trimmedNote);
        if (quest.notes.length > 20) {
          quest.notes.splice(0, quest.notes.length - 20);
        }
      }
    }
    if (reward !== undefined) {
      const trimmedReward = reward.trim();
      if (trimmedReward.length > 0) {
        quest.reward = trimmedReward;
      }
    }
    this.mutate();
    return {
      ok: true,
      message: `${created ? 'Created' : 'Updated'} quest "${quest.title}" → ${status}.`,
      events: [],
    };
  }

  upsertNpc(
    name: string,
    fields: { disposition?: Disposition; status?: NpcStatus; fact?: string },
  ): EngineResult {
    const trimmed = name.trim();
    if (trimmed.length < 1) {
      return { ok: false, error: `NPC name must not be empty (got "${name}").` };
    }
    const npcs = this.state.world.npcs;
    const existing = npcs.find((n) => n.name.toLowerCase() === trimmed.toLowerCase());
    let npc: Npc;
    let created: boolean;
    if (existing) {
      if (fields.disposition !== undefined) existing.disposition = fields.disposition;
      if (fields.status !== undefined) existing.status = fields.status;
      npc = existing;
      created = false;
    } else {
      npc = {
        name: trimmed,
        disposition: fields.disposition ?? 'neutral',
        status: fields.status ?? 'alive',
        facts: [],
      };
      npcs.push(npc);
      created = true;
    }
    if (fields.fact !== undefined) {
      const trimmedFact = fields.fact.trim();
      if (trimmedFact.length > 0 && !npc.facts.includes(trimmedFact)) {
        npc.facts.push(trimmedFact);
        if (npc.facts.length > 20) {
          npc.facts.splice(0, npc.facts.length - 20);
        }
      }
    }
    this.mutate();
    return {
      ok: true,
      message: `${created ? 'Created' : 'Updated'} NPC "${npc.name}" (${npc.disposition}, ${npc.status}).`,
      events: [],
    };
  }

  setLocation(name: string): EngineResult {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 80) {
      return { ok: false, error: `Location name must be 1-80 characters after trimming (got "${name}").` };
    }
    this.state.world.location = trimmed;
    this.mutate();
    return { ok: true, message: `Location set to "${trimmed}".`, events: [] };
  }

  recordFact(fact: string): EngineResult {
    const trimmed = fact.trim();
    if (trimmed.length < 1 || trimmed.length > 300) {
      return {
        ok: false,
        error: `Fact must be 1-300 characters after trimming (got ${trimmed.length}).`,
      };
    }
    const facts = this.state.world.facts;
    const isDuplicate = facts.includes(trimmed);
    if (!isDuplicate) {
      facts.push(trimmed);
      if (facts.length > 200) {
        facts.splice(0, facts.length - 200);
      }
    }
    this.mutate();
    return {
      ok: true,
      message: isDuplicate ? `Fact already recorded: "${trimmed}".` : `Recorded fact: "${trimmed}".`,
      events: [],
    };
  }
}
