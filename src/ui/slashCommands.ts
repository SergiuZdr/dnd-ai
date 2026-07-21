// Pure text formatting for the local (never sent to the DM, never appended to
// the transcript) slash commands: /help, /sheet, /journal, and the fallback
// note for an unrecognized command. Dispatch (which command maps to which
// controller call / navigation) lives in App.tsx for the TUI and
// src/web/server.ts for phone/web play -- this module only builds the
// strings shown in the story log/feed, and is ink-free (plain string
// builders) so both callers can share it unmodified.

import type { Chronicle, GameState } from '../game/state';
import { nextXpThreshold } from '../game/state';

export const SLASH_COMMANDS: ReadonlyArray<{ cmd: string; desc: string }> = [
  { cmd: '/sheet', desc: 'Show your full character sheet.' },
  { cmd: '/journal', desc: 'Show the story so far and chapter summaries.' },
  { cmd: '/save', desc: 'Save your progress immediately.' },
  { cmd: '/retire', desc: 'Retire your hero and raise a new one in this same world.' },
  { cmd: '/quit', desc: 'Save and exit the game.' },
  { cmd: '/help', desc: 'Show this list of commands.' },
];

export const KEY_HELP: ReadonlyArray<{ keys: string; desc: string }> = [
  { keys: 'PgUp / PgDn', desc: 'Scroll the story log up/down by half a screen.' },
  { keys: '[ / ]', desc: 'Same as PgUp/PgDn (works while the DM is narrating; disabled while you\'re typing so brackets type normally).' },
  { keys: 'SPACE or Enter', desc: 'Roll the dice when a roll is waiting on you.' },
  { keys: 'L', desc: 'Spend 1 luck to reroll (only offered after a failed roll, if you have luck left).' },
  { keys: 'Esc', desc: "Interrupt the DM mid-turn (does nothing while a roll is pending — it won't cancel your roll)." },
];

/** Phone/web equivalent of KEY_HELP -- taps instead of keys, no PgUp/bracket/SPACE talk. */
export const WEB_TAP_HELP: ReadonlyArray<{ action: string; desc: string }> = [
  { action: 'Scroll', desc: 'Just drag the story feed -- it only auto-scrolls when you were already at the bottom.' },
  { action: 'ROLL button', desc: 'Tap it when a roll card appears at the bottom.' },
  { action: 'Luck buttons', desc: 'REROLL spends 1 luck and keeps the better result; Accept keeps your roll as-is.' },
  { action: 'Stop', desc: "Interrupt the DM mid-turn (disabled while a roll card is up -- it won't cancel your roll)." },
];

export function formatHelp(): string {
  return [
    'Commands:',
    ...SLASH_COMMANDS.map(({ cmd, desc }) => `  ${cmd} — ${desc}`),
    '',
    'Keys:',
    ...KEY_HELP.map(({ keys, desc }) => `  ${keys} — ${desc}`),
  ].join('\n');
}

/**
 * Web version of /help: /retire and /quit aren't offered on web v1 (see
 * src/web/server.ts), so they're left out of the listing here rather than
 * advertising commands that just bounce back a "TUI-only" note; the tap
 * equivalents replace the TUI's keyboard-shortcut list.
 */
export function formatHelpWeb(): string {
  const webCommands = SLASH_COMMANDS.filter((c) => c.cmd !== '/retire' && c.cmd !== '/quit');
  return [
    'Commands:',
    ...webCommands.map(({ cmd, desc }) => `  ${cmd} — ${desc}`),
    '',
    'On your phone:',
    ...WEB_TAP_HELP.map(({ action, desc }) => `  ${action} — ${desc}`),
  ].join('\n');
}

export function formatCharacterSheet(state: GameState): string {
  const { character, world } = state;
  const next = nextXpThreshold(character.level);
  const xpText = next === null ? `${character.xp} (max level)` : `${character.xp} / ${next}`;

  const inventoryLines =
    character.inventory.length > 0
      ? character.inventory.map((item) => `  ${item.name} ×${item.qty}`).join('\n')
      : '  (empty)';

  const activeQuests = world.quests.filter((q) => q.status === 'active');
  const completedQuests = world.quests.filter((q) => q.status === 'completed');
  const activeLines =
    activeQuests.length > 0 ? activeQuests.map((q) => `    - ${q.title}`).join('\n') : '    (none active)';
  const completedLines =
    completedQuests.length > 0
      ? completedQuests.map((q) => `    - ${q.title}`).join('\n')
      : '    (none completed)';

  return [
    `${character.name} — ${character.race} ${character.className}, Level ${character.level}`,
    ...(character.background ? [`Background: ${character.background}`] : []),
    `XP: ${xpText}`,
    `HP: ${character.hp}/${character.maxHp}  AC: ${character.ac}`,
    `STR ${character.stats.str}  DEX ${character.stats.dex}  CON ${character.stats.con}  ` +
      `INT ${character.stats.int}  WIS ${character.stats.wis}  CHA ${character.stats.cha}`,
    `Gold: ${character.gold}  ✦ Luck: ${character.luck}`,
    '',
    'Inventory:',
    inventoryLines,
    '',
    'Quests:',
    '  Active:',
    activeLines,
    '  Completed:',
    completedLines,
    '',
    `Location: ${world.location}`,
  ].join('\n');
}

export function formatJournal(chronicle: Chronicle): string {
  const storySoFar = chronicle.storySoFar || 'The tale is just beginning.';
  if (chronicle.chapters.length === 0) {
    return storySoFar;
  }
  const chapterLines = chronicle.chapters.map((chapter, i) => `${i + 1}. ${chapter.summary}`).join('\n');
  return `${storySoFar}\n\n${chapterLines}`;
}

export function unknownCommandNote(input: string): string {
  return `Unknown command "${input}". Type /help to see available commands.`;
}
