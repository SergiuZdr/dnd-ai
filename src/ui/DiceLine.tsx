// A single flourish line for the latest dice roll, or nothing before the
// first roll of the session.
import { Text } from 'ink';

export interface DiceLineProps {
  message: string;
}

export function DiceLine({ message }: DiceLineProps) {
  if (!message) return null;
  return <Text color="yellow">{message}</Text>;
}
