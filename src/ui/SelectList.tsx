// Hand-rolled arrow-key select list — no new dependencies. Shared by the main
// menu, its load-campaign submenu, and every list-style wizard step.
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useRawModeActive } from './useRawModeActive';

export interface SelectOption<T> {
  key: string;
  label: string;
  value: T;
  description?: string;
}

export interface SelectListProps<T> {
  options: SelectOption<T>[];
  onSelect: (value: T) => void;
  /** Esc handler. Omit to make Esc a no-op (e.g. a top-level menu with nowhere to go back to). */
  onBack?: () => void;
  hint?: string;
}

export function SelectList<T>({ options, onSelect, onBack, hint }: SelectListProps<T>) {
  const [index, setIndex] = useState(0);
  const isActive = useRawModeActive();

  useInput(
    (_input, key) => {
      if (key.escape) {
        onBack?.();
        return;
      }
      if (options.length === 0) return;
      if (key.upArrow) {
        setIndex((i) => (i - 1 + options.length) % options.length);
      } else if (key.downArrow) {
        setIndex((i) => (i + 1) % options.length);
      } else if (key.return) {
        onSelect(options[index]!.value);
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {options.length === 0 && <Text dimColor>(nothing here)</Text>}
        {options.map((opt, i) => (
          <Box key={opt.key} flexDirection="column">
            <Text inverse={i === index}>{(i === index ? '> ' : '  ') + opt.label}</Text>
            {/* Tooltip: only the focused option's description shows, so a long
                list of richly-described options (classes/races/backgrounds)
                stays compact instead of printing every description at once. */}
            {i === index && opt.description && <Text dimColor>{`    ${opt.description}`}</Text>}
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{hint ?? '↑↓ choose · Enter select · Esc back'}</Text>
      </Box>
    </Box>
  );
}
