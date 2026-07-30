import { describe, it, expect } from 'vitest';
import { splitSuggestions, visibleStreamText, SUGGEST_MARKER } from '../../src/ai/suggestions';

describe('splitSuggestions', () => {
  it('pulls the trailer off the end and leaves clean prose', () => {
    const raw =
      'The constable blocks the door.\n\nWhat do you do?\n\n[[SUGGEST: Slip out the back | Bluff him | Draw your dagger]]';
    const { text, suggestions } = splitSuggestions(raw);
    expect(text).toBe('The constable blocks the door.\n\nWhat do you do?');
    expect(suggestions).toEqual(['Slip out the back', 'Bluff him', 'Draw your dagger']);
  });

  it('leaves a turn with no trailer completely untouched', () => {
    const raw = 'You wake in a cold room.\n\nWhat do you do?';
    expect(splitSuggestions(raw)).toEqual({ text: raw, suggestions: [] });
  });

  it('tolerates the sloppy formatting small models produce', () => {
    const cases = [
      '[[suggest: a | b | c]]',
      '[[SUGGEST a | b | c]]',
      '[[ SUGGEST :  a  |  b  |  c  ]]',
      '[[SUGGEST: "a" | - b | 1. c]]',
      '[[SUGGEST: a | b | c | ]]',
    ];
    for (const trailer of cases) {
      const { text, suggestions } = splitSuggestions(`Prose here.\n${trailer}`);
      expect(text, trailer).toBe('Prose here.');
      expect(suggestions, trailer).toEqual(['a', 'b', 'c']);
    }
  });

  it('caps at three suggestions and clamps an over-long one', () => {
    const long = 'x'.repeat(80);
    const { suggestions } = splitSuggestions(`P.\n[[SUGGEST: a | b | c | d | ${long}]]`);
    expect(suggestions).toHaveLength(3);
    expect(suggestions).toEqual(['a', 'b', 'c']);

    const { suggestions: clamped } = splitSuggestions(`P.\n[[SUGGEST: ${long}]]`);
    expect(clamped).toHaveLength(1);
    expect(clamped[0].length).toBeLessThanOrEqual(40);
    expect(clamped[0].endsWith('…')).toBe(true);
  });

  it('strips a misplaced trailer out of the middle rather than leaving the marker in prose', () => {
    const { text, suggestions } = splitSuggestions('[[SUGGEST: a | b | c]]\n\nThe door opens.');
    expect(text).toBe('The door opens.');
    expect(suggestions).toEqual(['a', 'b', 'c']);
  });

  it('yields no suggestions for an empty trailer but still removes it', () => {
    const { text, suggestions } = splitSuggestions('Aftermath only.\n[[SUGGEST: ]]');
    expect(text).toBe('Aftermath only.');
    expect(suggestions).toEqual([]);
  });
});

describe('visibleStreamText', () => {
  it('cuts everything from the marker onward', () => {
    expect(visibleStreamText('Prose.\n\n[[SUGGEST: a | b')).toBe('Prose.\n\n');
  });

  it('holds back a partially-arrived marker so it never flashes on screen', () => {
    // Every prefix of the marker must be suppressed, not just the whole thing --
    // deltas arrive a few characters at a time.
    for (let len = 1; len < SUGGEST_MARKER.length; len++) {
      const partial = SUGGEST_MARKER.slice(0, len);
      expect(visibleStreamText(`Prose.${partial}`), partial).toBe('Prose.');
    }
  });

  it('passes ordinary prose through unchanged, brackets included', () => {
    expect(visibleStreamText('He said "go" and left.')).toBe('He said "go" and left.');
    expect(visibleStreamText('A note reads [KEEP OUT] plainly.')).toBe('A note reads [KEEP OUT] plainly.');
  });

  it('never grows the text it was given', () => {
    const buf = 'Some prose that ends mid-mark [[SUG';
    expect(visibleStreamText(buf).length).toBeLessThanOrEqual(buf.length);
  });
});
