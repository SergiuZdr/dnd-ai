// A single flourish line for the latest dice roll. Always renders (a blank
// space before the first roll of the session) rather than returning null --
// this box shares a fixed-height row with RollPrompt (see App.tsx), and a
// component that sometimes renders 0 lines and sometimes 1 would shift the
// whole layout by a row every time a roll happens, one of the causes of the
// old sidebar flicker.
//
// wrap="truncate-end": ink wraps long Text onto multiple lines by default,
// which would blow the fixed 2-row dice area budget (App.tsx's
// DICE_AREA_HEIGHT) on a long message in a narrow terminal. Truncating
// instead guarantees exactly one line no matter what -- the full message
// still narrates fine through the DM regardless of what's visible here.
import { Text } from 'ink';

export interface DiceLineProps {
  message: string;
}

export function DiceLine({ message }: DiceLineProps) {
  return (
    <Text color="yellow" wrap="truncate-end">
      {message.length > 0 ? message : ' '}
    </Text>
  );
}
