import { describe, it, expect } from 'vitest';
import { appendTurnText } from '../../src/ai/dm';

describe('appendTurnText', () => {
  it('returns `next` unchanged when `existing` is empty (the first assistant text segment of a turn)', () => {
    expect(appendTurnText('', 'The tavern door creaks open.')).toBe('The tavern door creaks open.');
  });

  it('appends directly (no extra separator) when `existing` already ends in whitespace', () => {
    expect(appendTurnText('You step inside.\n\n', 'The room is dim.')).toBe(
      'You step inside.\n\nThe room is dim.',
    );
    expect(appendTurnText('You step inside. ', 'The room is dim.')).toBe('You step inside. The room is dim.');
    expect(appendTurnText('You step inside.\n', 'The room is dim.')).toBe('You step inside.\nThe room is dim.');
  });

  it('inserts a blank-line separator when `existing` does NOT end in whitespace', () => {
    expect(appendTurnText('You step inside.', 'The room is dim.')).toBe(
      'You step inside.\n\nThe room is dim.',
    );
  });

  it('regression: the exact glue case from the playtest screenshot -- two assistant-message text segments meeting mid-sentence with no separator', () => {
    const existing = 'The priest looks up slowly. What do you do?';
    const next = 'The priest draws a breath, and his voice drops lower...';
    const result = appendTurnText(existing, next);
    expect(result).toBe(
      'The priest looks up slowly. What do you do?\n\nThe priest draws a breath, and his voice drops lower...',
    );
    // The literal bug: no bare concatenation with zero separator between them.
    expect(result).not.toContain('do?The priest draws a breath');
  });
});
