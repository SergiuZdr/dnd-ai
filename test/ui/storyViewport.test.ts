import { describe, it, expect } from 'vitest';
import { wrapText, computeStoryViewport } from '../../src/ui/storyViewport';
import type { StoryLine } from '../../src/ui/storyViewport';
import type { StoryEntry } from '../../src/game/controller';

function entry(id: number, kind: StoryEntry['kind'], text: string): StoryEntry {
  return { id, kind, text };
}

describe('wrapText', () => {
  it('returns the whole line unwrapped when it fits', () => {
    expect(wrapText('hello world', 20)).toEqual(['hello world']);
  });

  it('word-wraps at the given width without splitting words', () => {
    expect(wrapText('the quick brown fox jumps', 10)).toEqual(['the quick', 'brown fox', 'jumps']);
  });

  it('hard-splits a single word longer than the width', () => {
    expect(wrapText('supercalifragilistic', 6)).toEqual(['superc', 'alifra', 'gilist', 'ic']);
  });

  it('preserves existing newlines as separate wrap groups', () => {
    expect(wrapText('line one\nline two', 20)).toEqual(['line one', 'line two']);
  });

  it('preserves blank lines', () => {
    expect(wrapText('para one\n\npara two', 20)).toEqual(['para one', '', 'para two']);
  });

  it('handles empty input', () => {
    expect(wrapText('', 20)).toEqual(['']);
  });

  it('clamps to width >= 1 even if given 0 or a negative width', () => {
    expect(() => wrapText('hi', 0)).not.toThrow();
    expect(() => wrapText('hi', -5)).not.toThrow();
  });
});

describe('computeStoryViewport', () => {
  it('never returns more lines than `height`, across a range of small heights', () => {
    const entries: StoryEntry[] = [
      entry(1, 'dm', 'The tavern is loud and warm.'),
      entry(2, 'player', 'I order a drink.'),
      entry(3, 'dm', 'The barkeep nods and pours.'),
    ];
    for (const height of [0, 1, 2, 3, 5, 10, 50]) {
      const { lines } = computeStoryViewport({ entries, partial: '', width: 40, height, scrollOffset: 0 });
      expect(lines.length).toBeLessThanOrEqual(height);
    }
  });

  it('returns EXACTLY `height` lines once there is enough content to fill it (padding with blanks otherwise)', () => {
    const entries: StoryEntry[] = [entry(1, 'dm', 'Short.')];
    const { lines } = computeStoryViewport({ entries, partial: '', width: 40, height: 5, scrollOffset: 0 });
    expect(lines.length).toBe(5);
  });

  it('sticks to the bottom (scrollOffset 0): the newest content is always the last line', () => {
    const entries: StoryEntry[] = [
      entry(1, 'dm', 'First message.'),
      entry(2, 'dm', 'Second message.'),
      entry(3, 'dm', 'Third and newest message.'),
    ];
    const { lines } = computeStoryViewport({ entries, partial: '', width: 40, height: 2, scrollOffset: 0 });
    expect(lines[lines.length - 1].text).toBe('Third and newest message.');
  });

  it('inserts exactly one blank line between entries', () => {
    const entries: StoryEntry[] = [entry(1, 'dm', 'One.'), entry(2, 'dm', 'Two.')];
    const { lines } = computeStoryViewport({ entries, partial: '', width: 40, height: 10, scrollOffset: 0 });
    const texts = lines.map((l) => l.text);
    const oneIdx = texts.indexOf('One.');
    const twoIdx = texts.indexOf('Two.');
    expect(twoIdx).toBe(oneIdx + 2);
    expect(texts[oneIdx + 1]).toBe('');
  });

  it('prefixes player entries with "> " on the first line and indents continuation lines to align', () => {
    const entries: StoryEntry[] = [entry(1, 'player', 'a rather long action that will need to wrap')];
    const { lines } = computeStoryViewport({ entries, partial: '', width: 15, height: 10, scrollOffset: 0 });
    const nonBlank = lines.filter((l) => l.text.length > 0);
    expect(nonBlank[0].text.startsWith('> ')).toBe(true);
    expect(nonBlank[0].color).toBe('cyan');
    // Continuation lines indent by the prefix width instead of repeating "> ".
    for (const line of nonBlank.slice(1)) {
      expect(line.text.startsWith('> ')).toBe(false);
      expect(line.color).toBe('cyan');
    }
  });

  it('renders system entries dim and italic', () => {
    const entries: StoryEntry[] = [entry(-1, 'system', 'Saved.')];
    const { lines } = computeStoryViewport({ entries, partial: '', width: 40, height: 3, scrollOffset: 0 });
    const line = lines.find((l) => l.text === 'Saved.');
    expect(line?.dimColor).toBe(true);
    expect(line?.italic).toBe(true);
  });

  it('appends the streaming partial text after the entries, with a blank line separator', () => {
    const entries: StoryEntry[] = [entry(1, 'player', 'I look around.')];
    const { lines } = computeStoryViewport({
      entries,
      partial: 'You see a dusty room.',
      width: 40,
      height: 10,
      scrollOffset: 0,
    });
    const texts = lines.map((l) => l.text);
    expect(texts).toContain('You see a dusty room.');
  });

  it('scrolling up (scrollOffset > 0) reveals earlier lines and appends a dim "newer text below" indicator as the last line', () => {
    const entries: StoryEntry[] = Array.from({ length: 10 }, (_, i) => entry(i + 1, 'dm', `Message ${i + 1}.`));
    const bottom = computeStoryViewport({ entries, partial: '', width: 40, height: 4, scrollOffset: 0 });
    expect(bottom.scrolledUp).toBe(false);
    expect(bottom.lines.some((l) => l.text.includes('newer text below'))).toBe(false);

    const scrolled = computeStoryViewport({ entries, partial: '', width: 40, height: 4, scrollOffset: 6 });
    expect(scrolled.scrolledUp).toBe(true);
    const last = scrolled.lines[scrolled.lines.length - 1];
    expect(last.text).toContain('newer text below');
    expect(last.dimColor).toBe(true);
    // The indicator still counts toward the height budget -- total length unchanged.
    expect(scrolled.lines.length).toBe(4);
  });

  it('clamps scrollOffset so it can never scroll past the top', () => {
    const entries: StoryEntry[] = [entry(1, 'dm', 'Only message.')];
    const { lines, scrolledUp } = computeStoryViewport({
      entries,
      partial: '',
      width: 40,
      height: 5,
      scrollOffset: 999999,
    });
    expect(lines.length).toBe(5);
    // Still shows the one real line somewhere in the window (not scrolled past into emptiness).
    expect(lines.some((l) => l.text === 'Only message.')).toBe(true);
    expect(typeof scrolledUp).toBe('boolean');
  });

  it('memoizes wrapped lines per (entry id, width) when a cache is supplied: unchanged entries are not re-wrapped', () => {
    const entries: StoryEntry[] = [
      entry(1, 'dm', 'A message long enough to wrap across more than one line at this width.'),
    ];
    const cache = new Map<string, StoryLine[]>();
    const first = computeStoryViewport({ entries, partial: '', width: 20, height: 10, scrollOffset: 0, cache });
    const second = computeStoryViewport({ entries, partial: '', width: 20, height: 10, scrollOffset: 0, cache });

    // Same underlying StoryLine objects (referential equality), proving the
    // second call reused the cached wrap instead of recomputing it.
    const firstNonBlank = first.lines.filter((l) => l.text.length > 0);
    const secondNonBlank = second.lines.filter((l) => l.text.length > 0);
    expect(firstNonBlank.length).toBeGreaterThan(0);
    expect(firstNonBlank[0]).toBe(secondNonBlank[0]);
  });

  it('re-wraps when the width changes even with the same cache', () => {
    const entries: StoryEntry[] = [entry(1, 'dm', 'A message long enough to wrap across more than one line.')];
    const cache = new Map<string, StoryLine[]>();
    const narrow = computeStoryViewport({ entries, partial: '', width: 15, height: 10, scrollOffset: 0, cache });
    const wide = computeStoryViewport({ entries, partial: '', width: 60, height: 10, scrollOffset: 0, cache });
    const narrowLineCount = narrow.lines.filter((l) => l.text.length > 0).length;
    const wideLineCount = wide.lines.filter((l) => l.text.length > 0).length;
    expect(wideLineCount).toBeLessThan(narrowLineCount);
  });

  it('handles an empty story (no entries, no partial) by returning `height` blank lines', () => {
    const { lines, scrolledUp } = computeStoryViewport({ entries: [], partial: '', width: 40, height: 4, scrollOffset: 0 });
    expect(lines.length).toBe(4);
    expect(lines.every((l) => l.text === '')).toBe(true);
    expect(scrolledUp).toBe(false);
  });

  it('handles height 0 by returning an empty array without throwing', () => {
    const entries: StoryEntry[] = [entry(1, 'dm', 'Something.')];
    expect(() => computeStoryViewport({ entries, partial: 'streaming', width: 40, height: 0, scrollOffset: 0 })).not.toThrow();
    const { lines } = computeStoryViewport({ entries, partial: 'streaming', width: 40, height: 0, scrollOffset: 0 });
    expect(lines).toEqual([]);
  });
});
