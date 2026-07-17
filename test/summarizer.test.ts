import { describe, it, expect } from 'vitest';
import { buildSummarizerPrompt, parseSummarizerReply } from '../src/ai/summarizer';
import type { TranscriptEntry } from '../src/game/saves';

function entry(role: TranscriptEntry['role'], text: string): TranscriptEntry {
  return { role, text, ts: '2024-01-01T00:00:00.000Z' };
}

describe('buildSummarizerPrompt', () => {
  it('includes the story-so-far rollup verbatim when non-empty', () => {
    const prompt = buildSummarizerPrompt([], 'Our hero arrived in town and met the mayor.');
    expect(prompt).toContain('CURRENT STORY-SO-FAR ROLLUP:\nOur hero arrived in town and met the mayor.');
  });

  it('falls back to the "just started" placeholder when the rollup is empty', () => {
    const prompt = buildSummarizerPrompt([], '');
    expect(prompt).toContain('CURRENT STORY-SO-FAR ROLLUP:\n(none yet — the campaign just started)');
  });

  it('formats player/dm entries as PLAYER:/DM: lines, oldest first, and skips system entries', () => {
    const chunk: TranscriptEntry[] = [
      entry('player', 'I open the door.'),
      entry('system', 'Game started.'),
      entry('dm', 'The door creaks open onto a dusty hall.'),
      entry('player', 'I step inside.'),
    ];
    const prompt = buildSummarizerPrompt(chunk, 'rollup');

    expect(prompt).toContain(
      'PLAYER: I open the door.\nDM: The door creaks open onto a dusty hall.\nPLAYER: I step inside.',
    );
    expect(prompt).not.toContain('Game started.');
    expect(prompt).not.toContain('SYSTEM:');
  });

  it('matches the exact required instruction framing (header, footer, format markers)', () => {
    const prompt = buildSummarizerPrompt([entry('player', 'Hi')], 'rollup');
    expect(prompt).toContain(
      'You are the chronicler of a long-running D&D campaign. Summarize game transcripts faithfully — preserve names, places, items, promises, debts, injuries, and unresolved threads. Never invent events.',
    );
    expect(prompt).toContain('NEW TRANSCRIPT CHUNK TO FOLD IN (oldest first):');
    expect(prompt).toContain('Reply with EXACTLY this format and nothing else:');
    expect(prompt).toContain('CHAPTER SUMMARY:');
    expect(prompt).toContain('STORY SO FAR:');
  });
});

describe('parseSummarizerReply', () => {
  it('happy path: extracts both sections trimmed', () => {
    const text = `CHAPTER SUMMARY:\nThe hero explored the ruins and found a key.\nSTORY SO FAR:\nThe hero has a key now.`;
    const result = parseSummarizerReply(text, 'previous rollup');
    expect(result).toEqual({
      chapterSummary: 'The hero explored the ruins and found a key.',
      storySoFar: 'The hero has a key now.',
    });
  });

  it('is case-insensitive when matching markers', () => {
    const text = `chapter summary:\nDid a thing.\nstory so far:\nRollup updated.`;
    const result = parseSummarizerReply(text, 'previous rollup');
    expect(result).toEqual({ chapterSummary: 'Did a thing.', storySoFar: 'Rollup updated.' });
  });

  it('tolerates mixed-case markers embedded mid-reply', () => {
    const text = `Some preamble the model added.\nChapter Summary:\nStuff happened.\nStory So Far:\nUpdated rollup text.`;
    const result = parseSummarizerReply(text, '');
    expect(result.chapterSummary).toBe('Stuff happened.');
    expect(result.storySoFar).toBe('Updated rollup text.');
  });

  it('drift: only CHAPTER SUMMARY found -- storySoFar falls back to the given fallback (non-empty)', () => {
    const text = `CHAPTER SUMMARY:\nThe hero fought a wolf and won.`;
    const result = parseSummarizerReply(text, 'Previous rollup stays.');
    expect(result.chapterSummary).toBe('The hero fought a wolf and won.');
    expect(result.storySoFar).toBe('Previous rollup stays.');
  });

  it('drift: only CHAPTER SUMMARY found -- storySoFar uses the chapter summary when fallback is empty', () => {
    const text = `CHAPTER SUMMARY:\nThe hero fought a wolf and won.`;
    const result = parseSummarizerReply(text, '');
    expect(result.chapterSummary).toBe('The hero fought a wolf and won.');
    expect(result.storySoFar).toBe('The hero fought a wolf and won.');
  });

  it('drift: no markers at all -- whole text becomes the chapter summary, storySoFar falls back (non-empty)', () => {
    const text = 'The hero simply wandered around town for a while, chatting with locals.';
    const result = parseSummarizerReply(text, 'Previous rollup stays.');
    expect(result.chapterSummary).toBe(text);
    expect(result.storySoFar).toBe('Previous rollup stays.');
  });

  it('drift: no markers at all -- storySoFar uses the whole text when fallback is empty', () => {
    const text = 'The hero simply wandered around town for a while.';
    const result = parseSummarizerReply(text, '');
    expect(result.chapterSummary).toBe(text);
    expect(result.storySoFar).toBe(text);
  });

  it('never returns an empty chapterSummary or storySoFar when text is non-empty (markers with nothing after them)', () => {
    const text = `CHAPTER SUMMARY:\nSTORY SO FAR:`;
    const result = parseSummarizerReply(text, '');
    expect(result.chapterSummary.length).toBeGreaterThan(0);
    expect(result.storySoFar.length).toBeGreaterThan(0);
  });

  it('never returns an empty chapterSummary when only a CHAPTER SUMMARY marker with nothing after it is present', () => {
    const text = `CHAPTER SUMMARY:`;
    const result = parseSummarizerReply(text, '');
    expect(result.chapterSummary.length).toBeGreaterThan(0);
    expect(result.storySoFar.length).toBeGreaterThan(0);
  });

  it('trims surrounding whitespace from both extracted sections', () => {
    const text = `CHAPTER SUMMARY:   \n\n  Padded chapter text.  \n\nSTORY SO FAR:\n\n   Padded rollup text.   \n\n`;
    const result = parseSummarizerReply(text, '');
    expect(result.chapterSummary).toBe('Padded chapter text.');
    expect(result.storySoFar).toBe('Padded rollup text.');
  });
});
