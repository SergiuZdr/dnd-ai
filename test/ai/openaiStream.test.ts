// Acceptance criterion: the SSE parser assembles interleaved `content`
// deltas and multi-index `tool_calls` from a canned OpenAI-style stream into
// the right onDelta-equivalent deltas + one executed tool call per index --
// entirely against a mocked/canned stream, no real network involved.

import { describe, it, expect } from 'vitest';
import { SseDecoder, StepAccumulator, SSE_DONE } from '../../src/ai/openaiStream';
import type { OpenAiStreamChunk } from '../../src/ai/openaiStream';

/** Renders one SSE `data: <json>\n\n` line from a plain object, so tests never hand-escape JSON-in-JSON strings. */
function sseLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe('SseDecoder', () => {
  it('parses a single complete data line into a JSON chunk object', () => {
    const decoder = new SseDecoder();
    const events = decoder.push(sseLine({ choices: [{ delta: { content: 'Hi' } }] }));
    expect(events).toEqual([{ choices: [{ delta: { content: 'Hi' } }] }]);
  });

  it('buffers a partial line split mid-JSON across two push() calls, emitting nothing until it completes', () => {
    const decoder = new SseDecoder();
    const whole = sseLine({ choices: [{ delta: { content: 'Hello there' } }] });
    const splitPoint = whole.indexOf('Hello') + 3; // split mid-word, mid-JSON-string

    const first = decoder.push(whole.slice(0, splitPoint));
    expect(first).toEqual([]);

    const second = decoder.push(whole.slice(splitPoint));
    expect(second).toEqual([{ choices: [{ delta: { content: 'Hello there' } }] }]);
  });

  it('emits the [DONE] sentinel literally, without attempting to JSON.parse it', () => {
    const decoder = new SseDecoder();
    const events = decoder.push('data: [DONE]\n\n');
    expect(events).toEqual([SSE_DONE]);
  });

  it('ignores blank/keep-alive lines and skips a malformed data line without throwing', () => {
    const decoder = new SseDecoder();
    const events = decoder.push(': keep-alive\n\ndata: not valid json\n\n' + sseLine({ choices: [] }));
    expect(events).toEqual([{ choices: [] }]);
  });

  it('handles multiple complete events arriving in a single push()', () => {
    const decoder = new SseDecoder();
    const combined = sseLine({ choices: [{ delta: { content: 'A' } }] }) + sseLine({ choices: [{ delta: { content: 'B' } }] });
    const events = decoder.push(combined);
    expect(events).toEqual([{ choices: [{ delta: { content: 'A' } }] }, { choices: [{ delta: { content: 'B' } }] }]);
  });
});

describe('StepAccumulator', () => {
  it('assembles interleaved content deltas and two parallel (multi-index) tool_calls from a canned, arbitrarily-chunked stream', () => {
    // A canned OpenAI-style chat-completion-chunk stream: narration text
    // interleaved with two parallel tool calls (index 0 and index 1), each
    // with id/name/arguments arriving in fragments across several chunks --
    // exactly how a real streaming response splits parallel tool calls.
    const chunkObjects: OpenAiStreamChunk[] = [
      { choices: [{ delta: { content: 'You ' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'roll_', arguments: '' } }] } }] },
      { choices: [{ delta: { content: 'push ' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'dice', arguments: '{"expr":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'set_location', arguments: '{"na' } }] } }] },
      { choices: [{ delta: { content: 'the door ' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"d20+3","reason":"Force the door","roller":"player"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: 'me":"Cellar Door"}' } }] } }] },
      { choices: [{ delta: { content: 'open.' } }] },
      { choices: [{ finish_reason: 'tool_calls', delta: {} }] },
    ];

    // Serialize to a raw SSE byte stream, then re-split it at arbitrary
    // (not line-aligned) byte offsets to prove the decoder+accumulator pair
    // handles real-world chunking, not just one-event-per-push.
    const rawStream = chunkObjects.map(sseLine).join('') + 'data: [DONE]\n\n';
    const wireChunks: string[] = [];
    for (let i = 0; i < rawStream.length; i += 17) {
      wireChunks.push(rawStream.slice(i, i + 17));
    }
    expect(wireChunks.length).toBeGreaterThan(1); // sanity: we actually split it

    const decoder = new SseDecoder();
    const acc = new StepAccumulator();
    const deltas: string[] = [];
    let sawDone = false;

    for (const wireChunk of wireChunks) {
      for (const event of decoder.push(wireChunk)) {
        if (event === SSE_DONE) {
          sawDone = true;
          continue;
        }
        const delta = acc.feed(event);
        if (delta) deltas.push(delta);
      }
    }

    expect(sawDone).toBe(true);
    expect(deltas).toEqual(['You ', 'push ', 'the door ', 'open.']);

    const result = acc.result();
    expect(result.content).toBe('You push the door open.');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toHaveLength(2);

    // Index order preserved (0 before 1) regardless of interleaving order above.
    expect(result.toolCalls[0]).toEqual({ id: 'call_1', name: 'roll_dice', arguments: '{"expr":"d20+3","reason":"Force the door","roller":"player"}' });
    expect(result.toolCalls[1]).toEqual({ id: 'call_2', name: 'set_location', arguments: '{"name":"Cellar Door"}' });

    // The assembled arguments are valid, parseable JSON matching the intent.
    expect(JSON.parse(result.toolCalls[0].arguments)).toEqual({ expr: 'd20+3', reason: 'Force the door', roller: 'player' });
    expect(JSON.parse(result.toolCalls[1].arguments)).toEqual({ name: 'Cellar Door' });
  });

  it('isDone() is false until a finish_reason chunk arrives, then true', () => {
    const acc = new StepAccumulator();
    expect(acc.isDone()).toBe(false);
    acc.feed({ choices: [{ delta: { content: 'hi' } }] });
    expect(acc.isDone()).toBe(false);
    acc.feed({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    expect(acc.isDone()).toBe(true);
  });

  it('result().finishReason is null and toolCalls/content are empty when nothing was ever fed', () => {
    const acc = new StepAccumulator();
    expect(acc.result()).toEqual({ content: '', toolCalls: [], finishReason: null });
  });

  it('ignores a chunk with no choices[0] without throwing', () => {
    const acc = new StepAccumulator();
    expect(() => acc.feed({ choices: [] })).not.toThrow();
    expect(acc.feed({ choices: [] })).toBeUndefined();
  });
});
