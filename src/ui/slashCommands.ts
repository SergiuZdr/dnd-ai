// Pure text formatting for the local (never sent to the DM, never appended to
// the transcript) slash commands: /help, /sheet, /journal, and the fallback
// note for an unrecognized command. Dispatch (which command maps to which
// controller call / navigation) lives in App.tsx -- this module only builds
// the strings shown in the story log.

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

export function formatHelp(): string {
  return ['Commands:', ...SLASH_COMMANDS.map(({ cmd, desc }) => `  ${cmd} — ${desc}`)].join('\n');
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
    `XP: ${xpText}`,
    `HP: ${character.hp}/${character.maxHp}  AC: ${character.ac}`,
    `STR ${character.stats.str}  DEX ${character.stats.dex}  CON ${character.stats.con}  ` +
      `INT ${character.stats.int}  WIS ${character.stats.wis}  CHA ${character.stats.cha}`,
    `Gold: ${character.gold}`,
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
