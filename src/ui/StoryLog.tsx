// Scrollback story log. Completed entries go through <Static> so ink prints
// them once and never re-renders/re-measures them again; the in-flight DM
// turn streams in below as an ordinary (repeatedly re-rendered) line.
import { Box, Static, Text } from 'ink';
import type { StoryEntry } from '../game/controller';

export interface StoryLogProps {
  entries: StoryEntry[];
  partial: string;
}

function EntryLine({ entry }: { entry: StoryEntry }) {
  if (entry.kind === 'player') {
    return <Text color="cyan">{`> ${entry.text}`}</Text>;
  }
  if (entry.kind === 'system') {
    return (
      <Text dimColor italic>
        {entry.text}
      </Text>
    );
  }
  return <Text>{entry.text}</Text>;
}

export function StoryLog({ entries, partial }: StoryLogProps) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Static items={entries}>
        {(entry) => (
          <Box key={entry.id} flexDirection="column" marginBottom={1}>
            <EntryLine entry={entry} />
          </Box>
        )}
      </Static>
      {partial.length > 0 && (
        <Box>
          <Text>{partial}</Text>
        </Box>
      )}
    </Box>
  );
}
