// Pure line-wrapping + windowing logic for the bounded story viewport. Kept
// separate from StoryLog.tsx so it's unit-testable without React/ink, and so
// wrapped lines can be memoized per (entry id, width) across renders --
// re-wrapping the whole scrollback every frame would be wasted CPU once a
// campaign runs long. Given the same inputs (entries, partial, width,
// height, scrollOffset) this ALWAYS returns the same output; the optional
// `cache` is a pure performance detail (a memoization table the caller
// keeps alive across renders), never part of the result.
import type { StoryEntry } from '../game/controller';

export interface StoryLine {
  /** Stable React key. */
  key: string;
  text: string;
  color?: 'cyan' | 'yellow';
  dimColor?: boolean;
  italic?: boolean;
}

export interface StoryViewportParams {
  entries: StoryEntry[];
  /** Accumulated text for the in-flight DM turn; '' when nothing is streaming. */
  partial: string;
  /** Rendering width in columns -- long lines are word-wrapped to this. */
  width: number;
  /** Exact number of lines to return -- the viewport NEVER renders more than this. */
  height: number;
  /** Lines scrolled up from the very bottom. 0 = stick to bottom (newest always visible). */
  scrollOffset: number;
  /** Optional memoization table (entry id + width -> wrapped lines), kept alive by the caller across renders. */
  cache?: Map<string, StoryLine[]>;
}

export interface StoryViewportResult {
  /** Exactly `height` lines (padded with blanks at the top if there isn't enough content yet). */
  lines: StoryLine[];
  /** True when scrolled away from the bottom -- the caller/UI shows the "newer text below" indicator in that case (already the last line of `lines`). */
  scrolledUp: boolean;
}

const BLANK_LINE: StoryLine = { key: '', text: '' };
const SCROLL_INDICATOR: StoryLine = { key: 'scroll-indicator', text: '▼ … newer text below', dimColor: true };

/**
 * Greedy word-wrap: breaks on spaces, hard-splits any single word wider than
 * `width`. Preserves existing newlines (each becomes its own wrap group) and
 * blank lines (an empty input line stays an empty output line).
 */
export function wrapText(text: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of rawLine.split(' ')) {
      let remaining = word;
      while (remaining.length > safeWidth) {
        if (current.length > 0) {
          lines.push(current);
          current = '';
        }
        lines.push(remaining.slice(0, safeWidth));
        remaining = remaining.slice(safeWidth);
      }
      const candidate = current.length === 0 ? remaining : `${current} ${remaining}`;
      if (candidate.length > safeWidth && current.length > 0) {
        lines.push(current);
        current = remaining;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}

/** Wraps one StoryEntry into styled lines: player entries get a `> ` prefix on their first line (continuations indent to align), dm entries are plain, system entries are dim+italic. */
function wrapEntry(entry: StoryEntry, width: number): StoryLine[] {
  const prefix = entry.kind === 'player' ? '> ' : '';
  const bodyWidth = Math.max(1, width - prefix.length);
  const wrapped = wrapText(entry.text, bodyWidth);
  return wrapped.map((line, i) => ({
    key: `${entry.id}:${i}`,
    text: i === 0 ? `${prefix}${line}` : `${' '.repeat(prefix.length)}${line}`,
    color: entry.kind === 'player' ? 'cyan' : undefined,
    dimColor: entry.kind === 'system' ? true : undefined,
    italic: entry.kind === 'system' ? true : undefined,
  }));
}

/** Given entries + partial text + width + height + scrollOffset, the exact list of styled wrapped lines to render. Never returns more than `height` lines. */
export function computeStoryViewport(params: StoryViewportParams): StoryViewportResult {
  const { entries, partial, width, height, scrollOffset, cache } = params;
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(0, height);

  const allLines: StoryLine[] = [];
  entries.forEach((entry, idx) => {
    if (idx > 0) allLines.push(BLANK_LINE);
    const cacheKey = `${entry.id}:${safeWidth}`;
    let lines = cache?.get(cacheKey);
    if (!lines) {
      lines = wrapEntry(entry, safeWidth);
      cache?.set(cacheKey, lines);
    }
    allLines.push(...lines);
  });

  if (partial.length > 0) {
    if (entries.length > 0) allLines.push(BLANK_LINE);
    wrapText(partial, safeWidth).forEach((line, i) => {
      allLines.push({ key: `partial:${i}`, text: line });
    });
  }

  const total = allLines.length;
  const maxScroll = Math.max(0, total - safeHeight);
  const clampedOffset = Math.max(0, Math.min(Math.floor(scrollOffset), maxScroll));
  const scrolledUp = clampedOffset > 0;

  // The indicator footer eats one line of the viewport when shown, so the
  // total never exceeds `height` even with it appended.
  const contentHeight = scrolledUp ? Math.max(0, safeHeight - 1) : safeHeight;

  const end = total - clampedOffset;
  const start = Math.max(0, end - contentHeight);
  const windowLines = allLines.slice(start, end);

  const padCount = Math.max(0, contentHeight - windowLines.length);
  const padded: StoryLine[] = [...Array.from({ length: padCount }, () => BLANK_LINE), ...windowLines];

  const result = scrolledUp ? [...padded, SCROLL_INDICATOR] : padded;

  return { lines: result.slice(0, safeHeight), scrolledUp };
}
