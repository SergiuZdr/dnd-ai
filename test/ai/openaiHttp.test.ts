// Unit tests for the shared PR-8 fault-tolerance policy (one retry with
// backoff on 5xx/network, no retry on 4xx or on a deliberate abort) used by
// both openaiDm.ts's streaming loop and summarizer.ts's one-shot call.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithRetry, isAbortError, errorMessageOf } from '../../src/ai/openaiHttp';

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
