// Bounded story viewport: renders EXACTLY `height` lines, every render --
// nothing ever spills into terminal scrollback (no <Static>, unlike the
// original version of this file). Wrapping + windowing is delegated to the
// pure computeStoryViewport() (storyViewport.ts); wrapped lines are memoized
// per (entry id, width) in a ref-held cache so streaming re-renders don't
// re-wrap the whole scrollback every ~80ms.
//
// Scrollback: PageUp/PageDown always scroll half a viewport. `[`/`]` do too,
// but only while the input bar is NOT focused (inputActive=false) --
// otherwise typing a literal "[" in an action would also scroll the log.
// Any new entry from the PLAYER, or the start of a fresh DM stream, snaps
// the view back to the bottom; other new content (DM replies mid-scroll,
// system notes) does not yank the view out from under someone reading back.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { StoryEntry } from '../game/controller';
import { computeStoryViewport } from './storyViewport';
import type { StoryLine } from './storyViewport';
import { useRawModeActive } from './useRawModeActive';

export interface StoryLogProps {
  entries: StoryEntry[];
  partial: string;
  width: number;
  height: number;
  /** True while the input bar is focused and capturing free text -- gates the `[`/`]` shortcuts so typing a bracket never also scrolls. PageUp/PageDown are always safe and stay active regardless. */
  inputActive: boolean;
}

function LineText({ line }: { line: StoryLine }) {
  return (
    // wrap="truncate-end": computeStoryViewport() already word-wraps every
    // line to `width` itself, so this is a defense-in-depth backstop (e.g.
    // wide-Unicode/emoji width-measurement drift between our wrapping and
    // ink's) -- if a line is ever a character or two too wide, truncating
    // preserves the "never exceeds height" guarantee instead of ink wrapping
    // it onto an extra line.
    <Text color={line.color} dimColor={line.dimColor} italic={line.italic} wrap="truncate-end">
      {line.text.length > 0 ? line.text : ' '}
    </Text>
  );
}

export function StoryLog({ entries, partial, width, height, inputActive }: StoryLogProps) {
  const [scrollOffset, setScrollOffset] = useState(0);
  const cacheRef = useRef(new Map<string, StoryLine[]>());
  const isActive = useRawModeActive();

  // Snap back to the bottom on a new PLAYER entry or the start of a fresh
  // stream -- but not on every partial tick, or scrolling up mid-stream to
  // reread something would be fought every ~80ms.
  const prevEntriesRef = useRef(entries);
  const wasStreamingRef = useRef(partial.length > 0);
  useEffect(() => {
    const prev = prevEntriesRef.current;
    if (entries.length > prev.length) {
      const added = entries.slice(prev.length);
      if (added.some((e) => e.kind === 'player')) {
        setScrollOffset(0);
      }
    }
    prevEntriesRef.current = entries;
  }, [entries]);
  useEffect(() => {
    const streaming = partial.length > 0;
    if (streaming && !wasStreamingRef.current) {
      setScrollOffset(0);
    }
    wasStreamingRef.current = streaming;
  }, [partial]);

  useInput(
    (input, key) => {
      const halfPage = Math.max(1, Math.floor(height / 2));
      const pageUp = key.pageUp || (!inputActive && input === '[');
      const pageDown = key.pageDown || (!inputActive && input === ']');
      if (pageUp) {
        setScrollOffset((offset) => offset + halfPage);
      } else if (pageDown) {
        setScrollOffset((offset) => Math.max(0, offset - halfPage));
      }
    },
    { isActive },
  );

  const { lines } = useMemo(
    () => computeStoryViewport({ entries, partial, width, height, scrollOffset, cache: cacheRef.current }),
    [entries, partial, width, height, scrollOffset],
  );

  return (
    <Box flexDirection="column" width={width} height={height}>
      {lines.map((line, i) => (
        <LineText key={line.key || `blank:${i}`} line={line} />
      ))}
    </Box>
  );
}
