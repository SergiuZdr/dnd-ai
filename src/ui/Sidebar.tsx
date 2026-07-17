// Character sheet + world ledger, always visible on the right. Pure
// presentation over a GameState snapshot -- no state of its own.
import { Box, Text } from 'ink';
import type { GameState } from '../game/state';
import { nextXpThreshold } from '../game/state';

export interface SidebarProps {
  state: GameState;
  width: number;
}

const HP_BAR_WIDTH = 16;
const MAX_INVENTORY_SHOWN = 8;
const MAX_QUESTS_SHOWN = 4;

function hpBarColor(ratio: number): string {
  if (ratio > 0.5) return 'green';
  if (ratio > 0.25) return 'yellow';
  return 'red';
}

function renderHpBar(hp: number, maxHp: number): { bar: string; color: string } {
  const ratio = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
  const filled = Math.round(ratio * HP_BAR_WIDTH);
  return {
    bar: '█'.repeat(filled) + '░'.repeat(HP_BAR_WIDTH - filled),
    color: hpBarColor(ratio),
  };
}

export function Sidebar({ state, width }: SidebarProps) {
  const { character, world } = state;
  const { bar, color } = renderHpBar(character.hp, character.maxHp);
  const next = nextXpThreshold(character.level);
  const xpText = next === null ? `${character.xp}/MAX` : `${character.xp}/${next}`;

  const shownItems = character.inventory.slice(0, MAX_INVENTORY_SHOWN);
  const inventoryOverflow = character.inventory.length - shownItems.length;

  const activeQuests = world.quests.filter((q) => q.status === 'active');
  const shownQuests = activeQuests.slice(0, MAX_QUESTS_SHOWN);
  const completedCount = world.quests.filter((q) => q.status === 'completed').length;

  return (
    <Box flexDirection="column" width={width} borderStyle="round" paddingX={1}>
      <Box flexDirection="column" flexGrow={1}>
        <Text bold>{character.name}</Text>
        <Text dimColor>{`Lv${character.level} ${character.race} ${character.className}`}</Text>

        <Box marginTop={1}>
          <Text color={color}>{bar}</Text>
        </Box>
        <Text>{`HP ${character.hp}/${character.maxHp}  AC ${character.ac}`}</Text>
        <Text>{`XP ${xpText}`}</Text>
        <Text>{`Gold ${character.gold}`}</Text>

        <Box marginTop={1}>
          <Text>
            {`STR${character.stats.str} DEX${character.stats.dex} CON${character.stats.con} ` +
              `INT${character.stats.int} WIS${character.stats.wis} CHA${character.stats.cha}`}
          </Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text dimColor>— Inventory —</Text>
          {shownItems.length === 0 && <Text dimColor>(empty)</Text>}
          {shownItems.map((item, i) => (
            <Text key={`${item.name}-${i}`}>{`${item.name} ×${item.qty}`}</Text>
          ))}
          {inventoryOverflow > 0 && <Text dimColor>{`+${inventoryOverflow} more…`}</Text>}
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text dimColor>— Quests —</Text>
          {shownQuests.length === 0 && <Text dimColor>(none active)</Text>}
          {shownQuests.map((quest) => (
            <Text key={quest.title}>{`◆ ${quest.title}`}</Text>
          ))}
          {completedCount > 0 && <Text dimColor>{`${completedCount} completed`}</Text>}
        </Box>
      </Box>

      <Text>{`📍 ${world.location}`}</Text>
    </Box>
  );
}
