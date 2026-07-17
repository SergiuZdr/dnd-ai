// One text-entry wizard step: a title, an ink-text-input, Enter to accept a
// non-blank value, Esc to go back.
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useRawModeActive } from '../useRawModeActive';

export interface TextPromptProps {
  title: string;
  initialValue?: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onBack: () => void;
}

export function TextPrompt({ title, initialValue = '', placeholder, onSubmit, onBack }: TextPromptProps) {
  const [value, setValue] = useState(initialValue);
  const isActive = useRawModeActive();

  useInput(
    (_input, key) => {
      if (key.escape) onBack();
    },
    { isActive },
  );

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    onSubmit(trimmed);
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>{title}</Text>
      <Box marginTop={1}>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder={placeholder}
          focus={isActive}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Enter confirm · Esc back</Text>
      </Box>
    </Box>
  );
}
