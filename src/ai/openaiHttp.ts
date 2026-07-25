// Small shared HTTP helpers for the OpenAI-compatible backend (openaiDm.ts's
// and dualDm.ts's streaming chat-completion loops, and summarizer.ts's
// one-shot chronicle call): the PR-8 / NFR-6.2 fault-tolerance policy -- one
// retry with a fixed backoff on a 5xx response or a thrown network error --
// lives here once so all call sites share the exact same behavior instead of
// drifting. Also carries the shared HTTP/network -> friendly DmError
// classification (originally openaiDm.ts-only; hoisted here once dualDm.ts's
// referee AND narrator phases both needed the identical mapping) so the
// error copy a player sees never depends on which OpenAI-compatible backend
// is active.

import { DmError } from './dm';

export interface FetchWithRetryOptions {
  /** Default 1 -- PR-8 asks for exactly one retry, not a full backoff schedule. */
  maxRetries?: number;
  /** Default 500ms. */
  backoffMs?: number;
}

/** True for the AbortError a caller's own AbortController.abort() produces -- never worth retrying (the caller cancelled on purpose, e.g. GameController.interrupt()). */
export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

export function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch() wrapped with the retry policy described above. A non-ok response
 * that ISN'T a 5xx (e.g. 400/401/429) is returned as-is, unretried -- for
 * those, retrying would just fail identically; the caller classifies them
 * into a friendly DmError instead.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts?: FetchWithRetryOptions,
): Promise<Response> {
  const maxRetries = opts?.maxRetries ?? 1;
  const backoffMs = opts?.backoffMs ?? 500;

  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(url, init);
      if (!res.ok && res.status >= 500 && attempt < maxRetries) {
        attempt += 1;
        await delay(backoffMs);
        continue;
      }
      return res;
    } catch (err) {
      if (isAbortError(err) || attempt >= maxRetries) throw err;
      attempt += 1;
      await delay(backoffMs);
    }
  }
}

/** Classifies a non-ok HTTP response from an OpenAI-compatible endpoint into a friendly DmError -- shared by every backend that talks to one (openaiDm.ts's single-model loop, dualDm.ts's referee/narrator phases) so the error copy never drifts between them. */
export function classifyHttpError(status: number, bodyText: string): DmError {
  const detail = bodyText.trim().slice(0, 500);
  const rawMessage = `HTTP ${status}${detail ? `: ${detail}` : ''}`;
  if (status === 401 || status === 403) {
    return new DmError(
      'auth',
      rawMessage,
      'The DM endpoint rejected the request (missing or invalid API key). Check openai.apiKeyEnv in settings.json and that the matching environment variable is set.',
    );
  }
  if (status === 429) {
    return new DmError(
      'rate_limit',
      rawMessage,
      'The weave is exhausted — the DM endpoint is rate-limiting requests. Try again in a few minutes.',
    );
  }
  if (status >= 500) {
    return new DmError('unknown', rawMessage, 'The DM endpoint had a server error. Try again shortly.');
  }
  return new DmError('unknown', rawMessage, `The DM endpoint returned an error (HTTP ${status}).`);
}

/** Classifies a thrown/caught network error (fetch itself failing, not an HTTP error status) into a friendly DmError. */
export function classifyNetworkError(err: unknown): DmError {
  const message = errorMessageOf(err);
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(message)) {
    return new DmError(
      'unknown',
      message,
      'Could not reach the DM endpoint. Is it running and reachable? (check openai.baseUrl in settings.json)',
    );
  }
  return new DmError('unknown', message, message);
}

/** Best-effort response body read for error-message context (classifyHttpError's `detail`) -- never throws. */
export async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
