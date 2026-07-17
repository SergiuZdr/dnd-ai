// The "roll 4d6 drop lowest" stats step: rolls 6 values on mount, previews
// them mapped to the chosen class's stat priority, lets the player reroll
// freely with R, and accepts with Enter.
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { roll4d6DropLowest, assignStats } from '../../game/newCampaign';
import type { Stats } from '../../game/state';
import { useRawModeActive } from '../useRawModeActive';

export interface StatsRollStepProps {
  priority: (keyof Stats)[];
  onAccept: (values: number[]) => void;
  onBack: () => void;
}

function rollSix(): number[] {
  return Array.from({ length: 6 }, () => roll4d6DropLowest());
}

export function StatsRollStep({ priority, onAccept, onBack }: StatsRollStepProps) {
  const [values, setValues] = useState<number[]>(rollSix);
  const isActive = useRawModeActive();

  useInput(
    (input, key) => {
      if (key.escape) {
        onBack();
      } else if (key.return) {
        onAccept(values);
      } else if (input.toLowerCase() === 'r') {
        setValues(rollSix());
      }
    },
    { isActive },
  );

  const preview = assignStats(values, priority);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Roll for stats (4d6, drop lowest)</Text>
      <Box marginTop={1}>
        <Text>{`Rolled: ${values.join(', ')}`}</Text>
      </Box>
      <Text>
        {`STR ${preview.str}  DEX ${preview.dex}  CON ${preview.con}  ` +
          `INT ${preview.int}  WIS ${preview.wis}  CHA ${preview.cha}`}
      </Text>
      <Box marginTop={1}>
        <Text dimColor>R reroll · Enter accept · Esc back</Text>
      </Box>
    </Box>
  );
}
