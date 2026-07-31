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
  /** Retries allowed specifically for a TRANSIENT 429 (see isTransientRateLimit). Default 3 -- free-tier shared pools throttle briefly and often, and each retry is far cheaper than losing the player's turn. */
  maxRateLimitRetries?: number;
  /** Base backoff for a transient 429, doubled each attempt and overridden by a Retry-After header. Default 1500ms. */
  rateLimitBackoffMs?: number;
}

/** Never wait longer than this on a Retry-After/backoff -- a turn that hangs for a minute is worse than a turn that fails honestly. */
const MAX_RATE_LIMIT_WAIT_MS = 8000;

/**
 * Distinguishes a 429 worth retrying from one that isn't.
 *
 * Free model tiers produce two very different 429s. A shared upstream pool
 * throttling for a few seconds ("temporarily rate-limited upstream") clears on
 * its own and is exactly what cost a live playtest turn mid-scene. A daily
 * quota exhaustion ("free-models-per-day", resets at midnight UTC) will fail
 * identically no matter how many times we ask, so retrying it just adds
 * latency to an error the player needs to see.
 */
export function isTransientRateLimit(bodyText: string): boolean {
  return !/per-?day|daily|free_tier_daily|quota|insufficient[_ ]credits|billing/i.test(bodyText);
}

/** Retry-After as ms, accepting both the delta-seconds and HTTP-date forms, clamped. Undefined when absent or unparseable. */
export function parseRetryAfterMs(headerValue: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return undefined;
    return Math.min(seconds * 1000, MAX_RATE_LIMIT_WAIT_MS);
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  const deltaMs = when - now;
  if (deltaMs <= 0) return 0;
  return Math.min(deltaMs, MAX_RATE_LIMIT_WAIT_MS);
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
 * fetch() wrapped with the retry policy described above, plus a separate,
 * more patient budget for transient 429s.
 *
 * 429 used to be returned as-is on the reasoning that retrying "would just
 * fail identically". That holds for a daily quota, but not for the shared
 * free-tier pools this game actually runs on, where a model is throttled for
 * a few seconds at a time -- and there, one unretried 429 costs the player a
 * whole turn mid-scene. Transient ones are now retried (honoring Retry-After
 * when the provider sends it); a quota/billing 429 is still returned
 * immediately so the player gets a truthful error instead of a long pause.
 * Other non-ok statuses (400/401/...) are returned unretried as before.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts?: FetchWithRetryOptions,
): Promise<Response> {
  const maxRetries = opts?.maxRetries ?? 1;
  const backoffMs = opts?.backoffMs ?? 500;
  const maxRateLimitRetries = opts?.maxRateLimitRetries ?? 3;
  const rateLimitBackoffMs = opts?.rateLimitBackoffMs ?? 1500;

  let attempt = 0;
  let rateLimitAttempt = 0;
  for (;;) {
    try {
      const res = await fetch(url, init);
      if (!res.ok && res.status >= 500 && attempt < maxRetries) {
        attempt += 1;
        await delay(backoffMs);
        continue;
      }
      if (res.status === 429 && rateLimitAttempt < maxRateLimitRetries) {
        // clone() so the body stays readable by the caller on the path where
        // we decide NOT to retry and hand this very response back.
        const body = await res
          .clone()
          .text()
          .catch(() => '');
        if (isTransientRateLimit(body)) {
          const waitMs =
            parseRetryAfterMs(res.headers.get('retry-after')) ??
            Math.min(rateLimitBackoffMs * 2 ** rateLimitAttempt, MAX_RATE_LIMIT_WAIT_MS);
          rateLimitAttempt += 1;
          await delay(waitMs);
          continue;
        }
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
