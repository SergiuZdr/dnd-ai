// Unit tests for the shared PR-8 fault-tolerance policy (one retry with
// backoff on 5xx/network, no retry on 4xx or on a deliberate abort) used by
// both openaiDm.ts's streaming loop and summarizer.ts's one-shot call.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchWithRetry,
  isAbortError,
  errorMessageOf,
  isTransientRateLimit,
  parseRetryAfterMs,
} from '../../src/ai/openaiHttp';

describe('fetchWithRetry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the response immediately on a first-try success (no retry)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRetry('http://example.test/x', {}, { backoffMs: 0 });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries exactly once on a 500 response, then returns the second (successful) response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRetry('http://example.test/x', {}, { backoffMs: 0 });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 400 (non-5xx) response -- returns it as-is on the first try', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRetry('http://example.test/x', {}, { backoffMs: 0 });

    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries exactly once on a thrown network error, then succeeds', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRetry('http://example.test/x', {}, { backoffMs: 0 });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries and rethrows the last network error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('still down'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWithRetry('http://example.test/x', {}, { backoffMs: 0, maxRetries: 1 })).rejects.toThrow('still down');
    expect(fetchMock).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it('never retries an AbortError -- rethrows immediately', async () => {
    const abortErr = new DOMException('Aborted', 'AbortError');
    const fetchMock = vi.fn().mockRejectedValue(abortErr);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWithRetry('http://example.test/x', {}, { backoffMs: 0 })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('isAbortError', () => {
  it('recognizes a DOMException named AbortError', () => {
    expect(isAbortError(new DOMException('Aborted', 'AbortError'))).toBe(true);
  });

  it('rejects a plain Error', () => {
    expect(isAbortError(new Error('nope'))).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isAbortError('AbortError')).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});

describe('errorMessageOf', () => {
  it('extracts .message from an Error', () => {
    expect(errorMessageOf(new Error('boom'))).toBe('boom');
  });

  it('stringifies a non-Error thrown value', () => {
    expect(errorMessageOf('just a string')).toBe('just a string');
  });
});

/**
 * Free-tier reality: a shared upstream pool throttles a model for a few
 * seconds at a time. An unretried 429 there costs the player a whole turn
 * mid-scene -- which is exactly what happened in a live playtest. A daily
 * quota 429 is the opposite: retrying only delays an error they need to see.
 */
describe('transient vs terminal rate limits', () => {
  it('treats an upstream shared-pool throttle as retriable', () => {
    const body = JSON.stringify({ error: { message: "openai/gpt-oss-20b:free is temporarily rate-limited upstream. Please retry shortly", metadata: { limit_source: "upstream_provider_shared_pool" } } });
    expect(isTransientRateLimit(body)).toBe(true);
  });

  it('treats a daily quota exhaustion as NOT retriable', () => {
    const body = JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day", metadata: { limit_source: "openrouter_free_tier_daily" } } });
    expect(isTransientRateLimit(body)).toBe(false);
  });

  it('treats credit/billing exhaustion as NOT retriable', () => {
    expect(isTransientRateLimit("insufficient credits")).toBe(false);
    expect(isTransientRateLimit("billing quota exceeded")).toBe(false);
  });
});

describe('parseRetryAfterMs', () => {
  it('accepts delta-seconds', () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs(" 3 ")).toBe(3000);
  });

  it('accepts an HTTP-date and converts it to a delay', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const later = new Date(now + 4000).toUTCString();
    expect(parseRetryAfterMs(later, now)).toBe(4000);
  });

  it('clamps absurd waits so a turn never hangs', () => {
    expect(parseRetryAfterMs("600")).toBe(8000);
  });

  it('returns undefined for missing or nonsense values, and 0 for a past date', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
    expect(parseRetryAfterMs("-5")).toBeUndefined();
    const now = Date.UTC(2026, 0, 1);
    expect(parseRetryAfterMs(new Date(now - 1000).toUTCString(), now)).toBe(0);
  });
});

describe('fetchWithRetry rate-limit behaviour', () => {
  it('retries a transient 429 and returns the eventual success', async () => {
    const transient = () => new Response(JSON.stringify({ error: { message: "temporarily rate-limited upstream" } }), { status: 429 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(transient())
      .mockResolvedValueOnce(transient())
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchWithRetry("http://x/v1/chat", {}, { rateLimitBackoffMs: 1 });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a daily-quota 429, and leaves its body readable', async () => {
    const body = JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-day" } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchWithRetry("http://x/v1/chat", {}, { rateLimitBackoffMs: 1 });
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(res.text()).resolves.toContain("free-models-per-day");
  });

  it('gives up after the rate-limit budget and returns the 429 rather than looping', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("temporarily rate-limited upstream", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchWithRetry("http://x/v1/chat", {}, { rateLimitBackoffMs: 1, maxRateLimitRetries: 2 });
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
