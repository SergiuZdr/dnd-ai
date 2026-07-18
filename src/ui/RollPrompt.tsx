// The interactive player dice roll widget: pause -> button -> animation ->
// reveal -> optional luck reroll. Rendered by App.tsx in place of DiceLine
// for the whole life of one pending roll, in the same fixed 2-row dice area
// (see DICE_AREA_HEIGHT in App.tsx) so the layout never shifts.
//
// This component OWNS keyboard input while a roll is pending (a dedicated
// useInput, separate from InputBar's) and calls back into the controller's
// plain confirmRoll()/resolvePendingRoll() methods -- it never touches the
// engine directly. The ~700ms cycling-die animation is purely cosmetic local
// state; the real roll only happens once confirmRoll() is called at the end
// of it. Esc is swallowed here unconditionally (never interrupts the DM
// turn while a roll is pending -- InputBar's own Esc handling is separately
// disabled for the same reason, see App.tsx's rollPending wiring).
import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { PendingRollRequest, RollRevealResult } from '../game/controller';
import { useRawModeActive } from './useRawModeActive';

export interface RollPromptProps {
  request: PendingRollRequest;
  onConfirm: () => RollRevealResult | undefined;
  onResolveLuck: (useLuck: boolean) => void;
}

const DIE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const ANIMATION_MS = 700;
const ANIMATION_FRAME_MS = 80;

type Phase = { kind: 'waiting' } | { kind: 'animating' } | { kind: 'revealed'; reveal: RollRevealResult };

export function RollPrompt({ request, onConfirm, onResolveLuck }: RollPromptProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'waiting' });
  const [face, setFace] = useState(DIE_FACES[0]);
  const isActive = useRawModeActive();

  useEffect(() => {
    if (phase.kind !== 'animating') return undefined;
    const interval = setInterval(() => {
      setFace(DIE_FACES[Math.floor(Math.random() * DIE_FACES.length)]);
    }, ANIMATION_FRAME_MS);
    const timeout = setTimeout(() => {
      const reveal = onConfirm();
      if (reveal) setPhase({ kind: 'revealed', reveal });
    }, ANIMATION_MS);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
    // onConfirm is re-created each render but always calls the same
    // controller instance for the same pending roll -- keying the effect off
    // phase.kind only (not onConfirm) is deliberate: re-running it on every
    // render would restart the animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind]);

  useInput(
    (input, key) => {
      if (key.escape) return; // never interrupts the DM turn while a roll is pending
      if (phase.kind === 'waiting' && (input === ' ' || key.return)) {
        setPhase({ kind: 'animating' });
        return;
      }
      if (phase.kind === 'revealed' && phase.reveal.canReroll) {
        onResolveLuck(input.toLowerCase() === 'l');
      }
    },
    { isActive },
  );

  // wrap="truncate-end" on every line here for the same reason as DiceLine:
  // this widget must always be exactly 2 rows (App.tsx's DICE_AREA_HEIGHT),
  // and ink wraps long Text onto multiple lines by default.
  if (phase.kind === 'waiting') {
    const dcText = request.dc !== undefined ? ` — DC ${request.dc}` : '';
    return (
      <Box flexDirection="column">
        <Text color="yellow" wrap="truncate-end">{`🎲 ${request.reason}${dcText} — press SPACE to roll`}</Text>
        <Text> </Text>
      </Box>
    );
  }

  if (phase.kind === 'animating') {
    return (
      <Box flexDirection="column">
        <Text color="yellow" wrap="truncate-end">{`${face} rolling…`}</Text>
        <Text> </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="yellow" wrap="truncate-end">
        {phase.reveal.message}
      </Text>
      <Text color="magenta" wrap="truncate-end">
        {phase.reveal.canReroll ? `✦ Luck ${phase.reveal.luck} — press L to reroll, Enter to accept` : ' '}
      </Text>
    </Box>
  );
}
