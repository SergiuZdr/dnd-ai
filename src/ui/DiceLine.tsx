// The dice area: a fixed 3-row card that is ALWAYS mounted (merges what used
// to be two components, DiceLine + RollPrompt) so the numbers always have
// their own row and can never be pushed off screen by a long DM-supplied
// `reason` -- see the bug this fixes: a sentence-length reason pushed the
// roll total/DC/success clean off the end of a single truncated line.
//
// Row layout (see App.tsx's DICE_AREA_HEIGHT):
//   idle       row1 = last-roll summary (compact for a just-resolved player
//              roll; the full one-liner message for a DM/NPC roll), rows 2-3 blank.
//   waiting    row1 = "🎲 ROLL — <reason>" (bold); row2 = what's needed to
//              succeed; row3 = "Press SPACE to roll".
//   animating  row1/row3 unchanged from waiting; row2 cycles die faces.
//   revealed   row1 = "🎲 <reason>"; row2 = the roll detail + pass/fail
//              (green/red); row3 = the luck offer, or blank once none applies.
// Every row keeps wrap="truncate-end" -- the reason is the only thing this
// widget ever allows to truncate; the numbers are composed on their own
// row from structured fields (RollRevealResult), never by parsing a string.
import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { PendingRollRequest, RollRevealResult } from '../game/controller';
import { useRawModeActive } from './useRawModeActive';

export interface DiceLineProps {
  /** Non-null while a player roll is awaiting SPACE/Enter/L; null otherwise. */
  request: PendingRollRequest | null;
  /** The full engine message for the most recent roll_dice call of ANY kind (player or DM) -- controller's existing onDiceRoll pipeline. Shown as-is for DM/NPC rolls; superseded by a compact summary right after a player roll resolves (see the suppression logic below). */
  fallbackMessage: string;
  onConfirm: () => RollRevealResult | undefined;
  onResolveLuck: (useLuck: boolean) => RollRevealResult | undefined;
}

const DIE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
// Slowed from 700/80 -- the terminal roll felt rushed next to the web
// client's ~1.2-1.6s BG3-style d20 reveal; this is deprecated-terminal
// polish only, kept in the same ballpark for a comparably weighty pause.
const ANIMATION_MS = 1500;
const ANIMATION_FRAME_MS = 100;

type Phase = 'idle' | 'waiting' | 'animating' | 'revealed';

// The three formatters below are pure string builders over structured data
// (never over `message`, never truncating anything but the reason) -- they
// are exported so tests can pin their exact output without rendering ink.

/** "Need 13+ on d20+3 to succeed" / "Roll d20+3" (no dc) -- the "waiting" row2 line. */
export function needLine(request: PendingRollRequest): string {
  return request.dc !== undefined ? `Need ${request.dc}+ on ${request.expr} to succeed` : `Roll ${request.expr}`;
}

/**
 * "Rolled [7]+3 = 10 — needed 13+ → ✓ SUCCESS" (green) / "✗ FAILURE" (red);
 * no dc: just "Rolled [7]+3 = 10". After a luck reroll, both totals show in
 * plain numbers (no per-die breakdown -- that level of detail is still in
 * `message` for the DM/transcript): "Rolled 7, luck reroll 16 — needed 13+ → ✓ SUCCESS".
 */
export function revealLine(reveal: RollRevealResult): { text: string; color?: 'green' | 'red' } {
  const firstPart = reveal.reroll
    ? `Rolled ${reveal.first.total}, luck reroll ${reveal.reroll.total}`
    : `Rolled ${reveal.first.text} = ${reveal.first.total}`;
  if (reveal.dc === undefined) {
    return { text: firstPart };
  }
  const symbol = reveal.success ? '✓' : '✗';
  const verdict = reveal.success ? 'SUCCESS' : 'FAILURE';
  return {
    text: `${firstPart} — needed ${reveal.dc}+ → ${symbol} ${verdict}`,
    color: reveal.success ? 'green' : 'red',
  };
}

/** "🎲 Persuasion — 7 vs 13 ✗" / "🎲 Persuasion — 14" (no dc) -- the compact idle summary after a player roll resolves. */
export function compactSummary(reveal: RollRevealResult): string {
  const dcText = reveal.dc !== undefined ? ` vs ${reveal.dc} ${reveal.success ? '✓' : '✗'}` : '';
  return `🎲 ${reveal.reason} — ${reveal.keptTotal}${dcText}`;
}

export function DiceLine({ request, fallbackMessage, onConfirm, onResolveLuck }: DiceLineProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [face, setFace] = useState(DIE_FACES[0]);
  const [reveal, setReveal] = useState<RollRevealResult | null>(null);
  const [idleText, setIdleText] = useState(fallbackMessage);
  const isActive = useRawModeActive();

  // A NEW roll request just arrived -- (re)start at 'waiting'.
  useEffect(() => {
    if (request) {
      setPhase('waiting');
      setReveal(null);
    }
  }, [request]);

  // Once the interactive path resolves (request goes non-null -> null),
  // fall back to idle -- idleText was already set to a compact summary by
  // whichever of onConfirm/onResolveLuck just produced the final reveal
  // (see below), and `reveal` itself is left populated (not cleared here)
  // so the fallback-echo check just below has something to compare against.
  const prevRequestRef = useRef(request);
  useEffect(() => {
    if (prevRequestRef.current !== null && request === null) {
      setPhase('idle');
    }
    prevRequestRef.current = request;
  }, [request]);

  // onDiceRoll (fallbackMessage) fires for EVERY roll_dice call, including
  // the one we just handled interactively -- and its text is IDENTICAL to
  // `reveal.message` in that case (both come from the very same engine
  // result). Recognizing that echo BY CONTENT (rather than by timing/order
  // relative to the request->null transition, which isn't guaranteed to be
  // observable in a fixed sequence across two independently-scheduled state
  // updates) is what keeps our compact summary on screen instead of it
  // being clobbered by the full, possibly-long verbose message. Any OTHER
  // fallbackMessage change is a genuinely different (DM/NPC) roll and
  // replaces the idle text normally.
  const prevFallbackRef = useRef(fallbackMessage);
  useEffect(() => {
    if (fallbackMessage === prevFallbackRef.current) return;
    prevFallbackRef.current = fallbackMessage;
    if (reveal && fallbackMessage === reveal.message) return;
    setIdleText(fallbackMessage);
  }, [fallbackMessage, reveal]);

  useEffect(() => {
    if (phase !== 'animating') return undefined;
    const interval = setInterval(() => {
      setFace(DIE_FACES[Math.floor(Math.random() * DIE_FACES.length)]);
    }, ANIMATION_FRAME_MS);
    const timeout = setTimeout(() => {
      const result = onConfirm();
      if (!result) return;
      setReveal(result);
      setPhase('revealed');
      if (!result.canReroll) {
        setIdleText(compactSummary(result));
      }
    }, ANIMATION_MS);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
    // onConfirm is re-created each render but always targets the same
    // pending roll -- keying off phase only (not onConfirm) is deliberate:
    // re-running on every render would restart the animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useInput(
    (input, key) => {
      if (key.escape) return; // never interrupts the DM turn while a roll is pending
      if (phase === 'waiting' && request && (input === ' ' || key.return)) {
        setPhase('animating');
        return;
      }
      if (phase === 'revealed' && reveal?.canReroll) {
        const result = onResolveLuck(input.toLowerCase() === 'l');
        if (result) {
          // Keep `reveal` current too -- the fallback-echo check above
          // compares against reveal.message, which must reflect this FINAL
          // (post-luck-decision) result, not the pre-decision one.
          setReveal(result);
          setIdleText(compactSummary(result));
        }
      }
    },
    { isActive },
  );

  if ((phase === 'waiting' || phase === 'animating') && request) {
    return (
      <Box flexDirection="column">
        <Text bold color="yellow" wrap="truncate-end">{`🎲 ROLL — ${request.reason}`}</Text>
        {phase === 'animating' ? (
          <Text wrap="truncate-end">{`${face} rolling…`}</Text>
        ) : (
          <Text wrap="truncate-end">{needLine(request)}</Text>
        )}
        <Text dimColor wrap="truncate-end">
          Press SPACE to roll
        </Text>
      </Box>
    );
  }

  if (phase === 'revealed' && reveal) {
    const { text, color } = revealLine(reveal);
    return (
      <Box flexDirection="column">
        <Text bold color="yellow" wrap="truncate-end">{`🎲 ${reveal.reason}`}</Text>
        <Text color={color} wrap="truncate-end">
          {text}
        </Text>
        <Text color="magenta" wrap="truncate-end">
          {reveal.canReroll ? `✦ Luck ${reveal.luck} — press L to reroll, Enter to accept` : ' '}
        </Text>
      </Box>
    );
  }

  // idle
  return (
    <Box flexDirection="column">
      <Text color="yellow" wrap="truncate-end">
        {idleText.length > 0 ? idleText : ' '}
      </Text>
      <Text> </Text>
      <Text> </Text>
    </Box>
  );
}
