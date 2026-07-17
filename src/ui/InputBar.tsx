// Bottom input bar: free-text action entry while idle, a narrating notice
// while the DM is streaming/thinking. Esc during that busy window interrupts
// the in-flight turn. Slash commands (including /quit) are not special-cased
// here -- everything typed is forwarded to onSubmit verbatim; App.tsx decides
// whether it's a slash command or a plain action.
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useRawModeActive } from './useRawModeActive';

export interface InputBarProps {
  busy: boolean;
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
}

export function InputBar({ busy, onSubmit, onInterrupt }: InputBarProps) {
  const [value, setValue] = useState('');
  const isActive = useRawModeActive();

  useInput(
    (_input, key) => {
      if (key.escape && busy) {
        onInterrupt();
      }
    },
    { isActive },
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
        <Text dimColor>The DM is narrating… (Esc to interrupt)</Text>
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
