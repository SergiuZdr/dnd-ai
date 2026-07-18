// The chronicler: a one-shot, cheap-model call that condenses a chunk of raw
// transcript into a short chapter summary and folds it into the running
// "story so far" rollup. This runs as its own `query()` -- separate from the
// DM session, no MCP tools, no streaming input, exactly one turn -- so it can
// use a cheaper model without touching the DM's own conversation.

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { TranscriptEntry } from '../game/saves';
import { loadSettings, resolveModelOption } from '../game/settings';

export interface SummarizeInput {
  chunk: TranscriptEntry[];
  storySoFar: string;
  /** Cheap-model override. Defaults to settings.json's summarizerModel (itself 'haiku' by default). */
  model?: string;
}

export interface SummarizeOutput {
  chapterSummary: string;
  storySoFar: string;
}

const CHAPTER_MARKER = 'CHAPTER SUMMARY:';
const STORY_MARKER = 'STORY SO FAR:';

export function buildSummarizerPrompt(chunk: TranscriptEntry[], storySoFar: string): string {
  const rollup = storySoFar || '(none yet — the campaign just started)';
  const entriesText = chunk
    .filter((entry) => entry.role !== 'system')
    .map((entry) => `${entry.role === 'player' ? 'PLAYER' : 'DM'}: ${entry.text}`)
    .join('\n');

  return `You are the chronicler of a long-running D&D campaign. Summarize game transcripts faithfully — preserve names, places, items, promises, debts, injuries, and unresolved threads. Never invent events.

CURRENT STORY-SO-FAR ROLLUP:
${rollup}

NEW TRANSCRIPT CHUNK TO FOLD IN (oldest first):
${entriesText}

Reply with EXACTLY this format and nothing else:
CHAPTER SUMMARY:
<5-10 sentences, past tense, covering this chunk's events>
STORY SO FAR:
<updated rollup, max 250 words, folding the new chapter into the previous rollup; keep plot-critical facts, drop trivia>`;
}

/**
 * Parses the chronicler's reply, tolerating drift from the requested format:
 * - both markers present (happy path): split cleanly between them.
 * - only CHAPTER SUMMARY present: the rollup carries over unchanged (falling
 *   back to the chapter summary itself if there was no prior rollup).
 * - neither marker present: the whole reply becomes the chapter summary,
 *   with the same rollup fallback behavior.
 * Never hands back an empty string for either field when `text` itself is
 * non-empty.
 */
export function parseSummarizerReply(text: string, fallbackStorySoFar: string): SummarizeOutput {
  const trimmedText = text.trim();
  const lower = text.toLowerCase();

  const chapterIdx = lower.indexOf(CHAPTER_MARKER.toLowerCase());
  const chapterContentStart = chapterIdx === -1 ? -1 : chapterIdx + CHAPTER_MARKER.length;

  let storyIdx = lower.indexOf(STORY_MARKER.toLowerCase());
  if (storyIdx !== -1 && chapterContentStart !== -1 && storyIdx < chapterContentStart) {
    // Garbled/reversed order -- treat the STORY marker as not found rather
    // than slicing a negative-length range out of the reply.
    storyIdx = -1;
  }
  const storyContentStart = storyIdx === -1 ? -1 : storyIdx + STORY_MARKER.length;

  let chapterSummary: string;
  let storySoFar: string;

  if (chapterIdx === -1) {
    // No CHAPTER SUMMARY marker anywhere -- the whole reply is the chapter summary.
    chapterSummary = trimmedText;
    storySoFar = fallbackStorySoFar.trim().length > 0 ? fallbackStorySoFar : trimmedText;
  } else if (storyIdx === -1) {
    // CHAPTER SUMMARY found, STORY SO FAR missing -- rollup carries over unchanged.
    chapterSummary = text.slice(chapterContentStart).trim();
    storySoFar = fallbackStorySoFar.trim().length > 0 ? fallbackStorySoFar : chapterSummary;
  } else {
    // Happy path: both markers found, in order.
    chapterSummary = text.slice(chapterContentStart, storyIdx).trim();
    storySoFar = text.slice(storyContentStart).trim();
  }

  // Safety net: never hand back an empty string when the reply itself was
  // non-empty (covers markers with nothing meaningful between/after them).
  if (trimmedText.length > 0) {
    if (chapterSummary.length === 0) chapterSummary = trimmedText;
    if (storySoFar.length === 0) {
      storySoFar = fallbackStorySoFar.trim().length > 0 ? fallbackStorySoFar : chapterSummary;
    }
  }

  return { chapterSummary, storySoFar };
}

export async function summarizeChunk(input: SummarizeInput): Promise<SummarizeOutput> {
  const prompt = buildSummarizerPrompt(input.chunk, input.storySoFar);
  // No onSystemNote-equivalent channel here -- a malformed settings.json is
  // already surfaced once via DmSession.start()'s warning, so this silently
  // falls back rather than repeating the same note on every chronicle update.
  const model = input.model ?? resolveModelOption(loadSettings().settings.summarizerModel);

  const q = query({
    prompt,
    options: {
      settingSources: [],
      tools: [],
      maxTurns: 1,
      ...(model !== undefined ? { model } : {}),
    },
  });

  for await (const message of q) {
    if (message.type !== 'result') continue;
    if (message.subtype === 'success') {
      return parseSummarizerReply(message.result, input.storySoFar);
    }
    const joined = message.errors.join('; ') || 'The chronicler encountered an unknown error.';
    throw new Error(joined);
  }

  throw new Error('The chronicler session ended without a result.');
}
