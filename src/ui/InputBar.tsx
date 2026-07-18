// Bottom input bar: free-text action entry while idle, a narrating notice
// while the DM is streaming/thinking. Esc during that busy window interrupts
// the in-flight turn -- EXCEPT while a player dice roll is pending
// (rollPending), where this whole hook goes inactive: RollPrompt owns
// keyboard input for that window instead, and Esc must be a total no-op so
// it can never interrupt the DM turn mid-roll. Slash commands (including
// /quit) are not special-cased here -- everything typed is forwarded to
// onSubmit verbatim; App.tsx decides whether it's a slash command or a plain
// action.
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useRawModeActive } from './useRawModeActive';

export interface InputBarProps {
  busy: boolean;
  /** True while a player roll is awaiting SPACE/Enter/L -- disables this bar's own key handling entirely (RollPrompt owns input instead). */
  rollPending: boolean;
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
}

export function InputBar({ busy, rollPending, onSubmit, onInterrupt }: InputBarProps) {
  const [value, setValue] = useState('');
  const isActive = useRawModeActive();

  useInput(
    (_input, key) => {
      if (key.escape && busy) {
        onInterrupt();
      }
    },
    { isActive: isActive && !rollPending },
  );

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    setValue('');
    onSubmit(trimmed);
  };

  return (
    <Box borderStyle="round" paddingX={1}>
      {busy ? (
        <Text dimColor>
          {rollPending ? 'Waiting on your roll…' : 'The DM is narrating… (Esc to interrupt)'}
        </Text>
      ) : (
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder="What do you do?"
          focus={isActive}
        />
      )}
    </Box>
  );
}
