// The DM's hands: an in-process MCP server exposing exactly the mechanical
// moves the AI layer is allowed to make. Every tool is a thin wrapper around
// one Engine method — the engine owns validation and state, the tool only
// translates between the LLM's tool-call args and Engine's EngineResult.

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Engine, EngineResult } from '../game/engine';
import type { RollMode } from '../game/dice';
import type { LedgerDelta } from '../game/state';

export interface InteractiveRollRequest {
  expr: string;
  mode?: RollMode;
  reason: string;
  dc?: number;
}

export interface ToolHooks {
  onToolResult?: (toolName: string, result: EngineResult) => void;
  /**
   * When present, roll_dice awaits this instead of calling engine.rollDice
   * directly for roller:'player' rolls -- the controller uses it to pause the
   * turn, prompt the UI, and resolve once the player has rolled (and possibly
   * spent luck on a reroll). Absent in headless contexts (smoke scripts,
   * tests, no UI): those always get the old instant-roll behavior.
   */
  interactiveRoll?: (request: InteractiveRollRequest) => Promise<EngineResult>;
  /**
   * Fires exactly once per successful (result.ok) award_gold / spend_gold /
   * award_xp / defeat_foe / add_item / remove_item call, with a structured delta describing what just
   * changed -- the controller wires this straight to
   * ControllerCallbacks.onLedgerGain so the web front-end can render a "YOU
   * GAINED" toast without parsing engine message strings. Never fires for a
   * failed (ok:false) result.
   */
  onLedger?: (delta: LedgerDelta) => void;
}

const SERVER_NAME = 'dnd';

/**
 * Shared handler tail: report the result to hooks, then translate it into the
 * MCP CallToolResult shape (ok -> plain text; error -> ERROR-prefixed text
 * with isError set, so the DM sees a clearly-flagged failure and can weave a
 * correction into the story instead of the game silently diverging from
 * reality).
 */
function toCallToolResult(result: EngineResult) {
  if (result.ok) {
    return { content: [{ type: 'text' as const, text: result.message }] };
  }
  return {
    content: [{ type: 'text' as const, text: `ERROR: ${result.error}` }],
    isError: true,
  };
}

export function createDmTools(
  engine: Engine,
  hooks?: ToolHooks,
): {
  server: McpSdkServerConfigWithInstance;
  allowedTools: string[];
  serverName: 'dnd';
  /** Raw tool definitions (handler included) -- exposed mainly so tests can call handlers directly without going through the MCP server. */
  tools: SdkMcpToolDefinition<any>[];
} {
  const rollDice = tool(
    'roll_dice',
    'Roll dice to resolve ANY uncertain outcome — attacks, skill checks, saving throws, luck. ' +
      'Call this BEFORE narrating the outcome, never after: the roll decides what happens, ' +
      'narration follows it. A bad roll means things go badly — never fudge or ignore the result. ' +
      'Set dc to the target number (meet-or-beat succeeds) whenever the fiction has a difficulty — for ' +
      "attacks, use the target's effective defense. Set roller:'player' whenever the HERO is the one " +
      "attacking/checking/saving (this pauses so the player can physically roll); use roller:'dm' (or " +
      'omit it) for NPC, monster, or world rolls the DM is making on their behalf.',
    {
      expr: z.string().describe('e.g. "d20", "2d6+3"'),
      mode: z.enum(['normal', 'advantage', 'disadvantage']).optional(),
      reason: z
        .string()
        .describe(
          'Short check label, 3-6 words, e.g. "Persuasion — sway the constable". Never a full sentence -- ' +
            'it is displayed on screen next to the roll and gets cut off if long.',
        ),
      dc: z.number().int().optional().describe('Target number to meet or beat for success, when the fiction calls for one.'),
      roller: z
        .enum(['player', 'dm'])
        .optional()
        .describe("'player' when the hero attacks/checks/saves; 'dm' for NPC/monster/world rolls."),
    },
    async ({ expr, mode, reason, dc, roller }) => {
      if (roller === 'player' && hooks?.interactiveRoll) {
        const result = await hooks.interactiveRoll({ expr, mode, reason, dc });
        hooks.onToolResult?.('roll_dice', result);
        return toCallToolResult(result);
      }
      const result = engine.rollDice(expr, mode, reason, dc);
      hooks?.onToolResult?.('roll_dice', result);
      return toCallToolResult(result);
    },
    { annotations: { readOnlyHint: true } },
  );

  const applyDamage = tool(
    'apply_damage',
    'Call the instant the hero takes damage, immediately as it happens in the fiction — ' +
      'combat hits, traps, falls, poison, anything that hurts them.',
    {
      amount: z.number().int(),
      reason: z.string(),
    },
    async ({ amount, reason }) => {
      const result = engine.applyDamage(amount, reason);
      hooks?.onToolResult?.('apply_damage', result);
      return toCallToolResult(result);
    },
  );

  const heal = tool(
    'heal',
    'Call whenever the hero recovers HP — resting, potions, spells, a healer\'s care — ' +
      'immediately as it happens.',
    {
      amount: z.number().int(),
      reason: z.string(),
    },
    async ({ amount, reason }) => {
      const result = engine.heal(amount, reason);
      hooks?.onToolResult?.('heal', result);
      return toCallToolResult(result);
    },
  );

  const awardXp = tool(
    'award_xp',
    'Call to award experience for defeated foes, clever solutions, and completed quests. ' +
      'Guide: 25-100 for minor wins, 150-450 for significant ones, 500+ for major/campaign-shaping ones.',
    {
      amount: z.number().int(),
    },
    async ({ amount }) => {
      const result = engine.awardXp(amount);
      hooks?.onToolResult?.('award_xp', result);
      if (result.ok) {
        hooks?.onLedger?.({
          xp: amount,
          leveledTo: result.events.includes('level-up') ? engine.state.character.level : undefined,
        });
      }
      return toCallToolResult(result);
    },
  );

  // The fix for "a whole fight that ends with 0 XP". Telling the referee to
  // remember award_xp did not work: a live playtest killed a bandit on a
  // natural 20, confirmed the body and looted it across three turns, and XP
  // never moved off 0 -- award_xp is bookkeeping, and bookkeeping is exactly
  // what a small model drops. defeat_foe is keyed to something it cannot miss
  // (the foe stopped fighting) and bundles the two calls that must both happen
  // anyway, so the reliable trigger and the easily-forgotten reward become one
  // action.
  const defeatFoe = tool(
    'defeat_foe',
    'Call the moment an enemy stops being a threat — killed, knocked out, driven off, or surrendered. ' +
      'This is how a fight ENDS: it records the foe and awards the hero their XP in a single step. ' +
      'A fight the hero wins must never end without this call. ' +
      'xp guide: 25-100 a thug, a wolf, a minor threat; 150-450 a real fight; 500+ a boss or a campaign turn.',
    {
      name: z.string().describe('The foe, e.g. "Cleft bandit" — the same name you would pass to upsert_npc.'),
      xp: z.number().int().describe('XP the hero earns. 25-100 minor, 150-450 significant, 500+ major.'),
      outcome: z.enum(['killed', 'incapacitated', 'fled', 'surrendered']).optional(),
    },
    async ({ name, xp, outcome }) => {
      const amount = Math.abs(xp);
      const xpResult = engine.awardXp(amount);
      if (xpResult.ok) {
        hooks?.onLedger?.({
          xp: amount,
          leveledTo: xpResult.events.includes('level-up') ? engine.state.character.level : undefined,
        });
      }

      const how = outcome ?? 'killed';
      const status = how === 'killed' ? 'dead' : how === 'fled' ? 'missing' : 'alive';
      const npcResult = engine.upsertNpc(name, {
        status,
        fact: `Defeated by ${engine.state.character.name} (${how}).`,
      });

      // One combined result, so the referee sees a single honest answer: the
      // XP line is what matters mechanically, the NPC line only if it failed.
      const result: EngineResult = xpResult.ok
        ? {
            ok: true,
            message: npcResult.ok
              ? `${name} ${how}. ${xpResult.message}`
              : `${name} ${how}. ${xpResult.message} (could not record the foe: ${npcResult.error})`,
            events: xpResult.events,
          }
        : xpResult;
      hooks?.onToolResult?.('defeat_foe', result);
      return toCallToolResult(result);
    },
  );

  // Two positive-only tools where there used to be one signed
  // modify_gold(delta). In a live playtest the referee answered "I pocket the
  // ten gold pieces" with delta:-10 -- looting a corpse left the hero POORER
  // than before he looted it. Direction was the one thing the model had to get
  // right and the one thing a single signed argument let it get backwards, so
  // direction is no longer carried in the argument at all: it is the choice of
  // tool. Math.abs() closes the last gap, since a model that "helpfully" signs
  // the amount (spend_gold with -10) then still spends rather than reversing
  // the transfer. The schema stays a plain int for the same reason -- a
  // .positive() constraint would reject that call outright instead of doing
  // the obvious right thing with it.
  const awardGold = tool(
    'award_gold',
    'Call the moment gold ARRIVES for the hero — loot taken from a body or a chest, a reward, a bounty, ' +
      'payment for a job, winnings, treasure found. amount is how much they GAIN. ' +
      'If the hero picks up, pockets, takes, or is handed coin, it is THIS tool, never spend_gold.',
    {
      amount: z.number().int().describe('How much gold the hero GAINS. Positive.'),
      reason: z.string(),
    },
    async ({ amount, reason }) => {
      const gained = Math.abs(amount);
      const result = engine.modifyGold(gained);
      hooks?.onToolResult?.('award_gold', result);
      if (result.ok) hooks?.onLedger?.({ gold: gained });
      return toCallToolResult(result);
    },
  );

  const spendGold = tool(
    'spend_gold',
    'Call the moment gold LEAVES the hero — a purchase, a room for the night, a bribe they pay, a toll, ' +
      'a fine, a debt settled, coin stolen from them. amount is how much they LOSE. ' +
      'Never use this when the hero receives money — that is award_gold.',
    {
      amount: z.number().int().describe('How much gold the hero LOSES. Positive.'),
      reason: z.string(),
    },
    async ({ amount, reason }) => {
      const spent = Math.abs(amount);
      const result = engine.modifyGold(-spent);
      hooks?.onToolResult?.('spend_gold', result);
      if (result.ok) hooks?.onLedger?.({ gold: -spent });
      return toCallToolResult(result);
    },
  );

  const addItem = tool(
    'add_item',
    'Call the moment the hero gains a possession — loot, a purchase, a gift, something crafted or found. ' +
      'Put the COUNT IN qty AND NEVER IN name: five healing tinctures are name:"Healing tincture", qty:5 — ' +
      'never name:"Healing tinctures (5 bottles)", qty:1. A count baked into the name cannot be spent: ' +
      'remove_item matches on the exact name, so consuming one of them would either delete the whole stack ' +
      'or fail outright. Keep names singular and generic for the same reason, so a later remove_item can match.',
    {
      name: z.string().describe('Singular item name with NO count in it, e.g. "Healing tincture" — the count belongs in qty.'),
      qty: z.number().int().optional(),
    },
    async ({ name, qty }) => {
      const result = engine.addItem(name, qty);
      hooks?.onToolResult?.('add_item', result);
      if (result.ok) hooks?.onLedger?.({ itemsAdded: [{ name, qty: qty ?? 1 }] });
      return toCallToolResult(result);
    },
  );

  const removeItem = tool(
    'remove_item',
    'Call the moment a possession is lost, consumed, sold, or given away.',
    {
      name: z.string(),
      qty: z.number().int().optional(),
    },
    async ({ name, qty }) => {
      const result = engine.removeItem(name, qty);
      hooks?.onToolResult?.('remove_item', result);
      if (result.ok) hooks?.onLedger?.({ itemsRemoved: [{ name, qty: qty ?? 1 }] });
      return toCallToolResult(result);
    },
  );

  const upsertQuest = tool(
    'upsert_quest',
    'Call whenever a quest starts, advances, or ends: set its current status and, optionally, ' +
      'a short note of what just changed. Whenever a quest becomes/updates to active, ALWAYS also ' +
      "pass a short reward estimate (e.g. '≈200 gold + a favor') so the player can see what's at stake.",
    {
      title: z.string(),
      status: z.enum(['active', 'completed', 'failed', 'abandoned']),
      note: z.string().optional(),
      reward: z
        .string()
        .optional()
        .describe(
          'Short estimate of what the hero can expect from this quest, e.g. "≈200 gold + a favor" or ' +
            '"~150 gold, minor loot, and XP". Keep it under ~8 words. Revise it if the deal changes.',
        ),
    },
    async ({ title, status, note, reward }) => {
      const result = engine.upsertQuest(title, status, note, reward);
      hooks?.onToolResult?.('upsert_quest', result);
      return toCallToolResult(result);
    },
  );

  const upsertNpc = tool(
    'upsert_npc',
    'Call the first time a named character appears, and again whenever their disposition, ' +
      'status, or a memorable fact about them changes.',
    {
      name: z.string(),
      disposition: z.enum(['friendly', 'neutral', 'hostile']).optional(),
      status: z.enum(['alive', 'dead', 'missing', 'unknown']).optional(),
      fact: z.string().optional(),
    },
    async ({ name, disposition, status, fact }) => {
      const result = engine.upsertNpc(name, { disposition, status, fact });
      hooks?.onToolResult?.('upsert_npc', result);
      return toCallToolResult(result);
    },
  );

  const setLocation = tool(
    'set_location',
    'Call whenever the scene moves to a new place, even a short walk to a different room or ' +
      'clearing — keep it current so the sidebar and future context always show where the hero is.',
    {
      name: z.string(),
    },
    async ({ name }) => {
      const result = engine.setLocation(name);
      hooks?.onToolResult?.('set_location', result);
      return toCallToolResult(result);
    },
  );

  const recordFact = tool(
    'record_fact',
    'Call to permanently record a lasting world truth — one that must be remembered and honored ' +
      'months of play from now, even after this conversation is long gone.',
    {
      fact: z.string(),
    },
    async ({ fact }) => {
      const result = engine.recordFact(fact);
      hooks?.onToolResult?.('record_fact', result);
      return toCallToolResult(result);
    },
  );

  const tools = [
    rollDice,
    applyDamage,
    heal,
    awardXp,
    defeatFoe,
    awardGold,
    spendGold,
    addItem,
    removeItem,
    upsertQuest,
    upsertNpc,
    setLocation,
    recordFact,
  ];

  const server = createSdkMcpServer({ name: SERVER_NAME, tools });
  const allowedTools = tools.map((t) => `mcp__${SERVER_NAME}__${t.name}`);

  return { server, allowedTools, serverName: SERVER_NAME, tools };
}
