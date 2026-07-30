// The chronicler: a one-shot, cheap-model call that condenses a chunk of raw
// transcript into a short chapter summary and folds it into the running
// "story so far" rollup. Always exactly one turn, no tools, no streaming
// input, and always separate from the DM's own conversation -- so it can use a
// cheaper model without touching it.
//
// Which endpoint it calls follows settings.dmBackend (see summarizeChunk):
// 'openai' AND 'dual' both go to the OpenAI-compatible endpoint, 'claude' to
// the Agent SDK. The 'dual' case matters more than it looks -- see the comment
// at that branch.

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { TranscriptEntry } from '../game/saves';
import { loadSettings, resolveModelOption } from '../game/settings';
import type { OpenAiSettings } from '../game/settings';
import { fetchWithRetry } from './openaiHttp';

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

/**
 * One-shot (non-streaming) OpenAI-compatible chat completion -- the
 * chronicler needs exactly one reply, no tools, no streaming, so this skips
 * all of openaiDm.ts's agentic-loop machinery and just posts+reads a single
 * JSON response. Shares the PR-8 fault-tolerance policy (fetchWithRetry: one
 * retry on 5xx/network) with the DM backend itself.
 */
async function callOpenAiChatOnce(openai: OpenAiSettings, model: string, prompt: string): Promise<string> {
  const url = `${openai.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (openai.apiKeyEnv) {
    const key = process.env[openai.apiKeyEnv];
    if (key) headers.Authorization = `Bearer ${key}`;
  }

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`chronicler endpoint returned HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 500)}` : ''}`);
  }

  const json: unknown = await res.json();
  const content = (json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('chronicler endpoint returned an empty response');
  }
  return content;
}

export async function summarizeChunk(input: SummarizeInput): Promise<SummarizeOutput> {
  const prompt = buildSummarizerPrompt(input.chunk, input.storySoFar);
  // No onSystemNote-equivalent channel here -- a malformed settings.json is
  // already surfaced once via DmSession.start()'s warning, so this silently
  // falls back rather than repeating the same note on every chronicle update.
  const { settings } = loadSettings();

  // 'dual' belongs on this branch every bit as much as 'openai' does. The
  // referee/narrator split is a property of the DM *turn* only; the chronicler
  // is one plain completion either way. Letting 'dual' fall through to the
  // Claude path below was a real bug with two faces: locally it quietly spent
  // Claude tokens on a backend chosen specifically to spend none (the SRD's
  // headline metric is "Claude tokens consumed during play: 0"), and on a
  // headless host -- where there is no Claude Code login to fall back to -- it
  // threw on every attempt, so lastSummarizedIndex never advanced, the retry
  // fired again after each turn, and resume replayed the entire transcript
  // instead of the recent tail.
  //
  // openai.model (the REFEREE's model under 'dual') is the right one to use
  // here, not narratorModel: this is faithful structured summarization, which
  // is what the reliable tool-caller was picked for.
  if (settings.dmBackend === 'openai' || settings.dmBackend === 'dual') {
    const model = input.model ?? settings.openai.model;
    const text = await callOpenAiChatOnce(settings.openai, model, prompt);
    return parseSummarizerReply(text, input.storySoFar);
  }

  const model = input.model ?? resolveModelOption(settings.summarizerModel);

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
