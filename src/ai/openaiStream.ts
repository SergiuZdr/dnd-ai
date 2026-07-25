// Pure, network-free pieces of the OpenAI-compatible streaming chat
// protocol (PR-3): SseDecoder turns raw text chunks (as they arrive off the
// wire, split however the network happened to split them) into parsed SSE
// data payloads; StepAccumulator folds those payloads into one step's
// narration text + multi-index tool_calls. Kept separate from openaiDm.ts's
// fetch/loop orchestration so both can be exercised in tests against a
// canned/mocked stream with zero network involved.

/** One `tool_calls` delta fragment for one index, as OpenAI-compatible servers stream it -- name/arguments arrive in pieces across many chunks, keyed by `index` (parallel tool calls each get their own index). */
export interface OpenAiToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** One parsed `data: {...}` chat-completion-chunk payload. */
export interface OpenAiStreamChunk {
  choices?: Array<{
    index?: number;
    delta?: { role?: string; content?: string | null; tool_calls?: OpenAiToolCallDelta[] };
    finish_reason?: string | null;
  }>;
}

/** A fully-assembled tool call, ready to be JSON.parse'd and repaired/validated. */
export interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface StepResult {
  content: string;
  toolCalls: AccumulatedToolCall[];
  /** null if the stream ended (or was still open) without ever reporting one -- see openaiDm.ts's stream-truncation handling. */
  finishReason: string | null;
}

/** The `[DONE]` sentinel OpenAI-compatible servers send as the final SSE data line. */
export const SSE_DONE = '[DONE]' as const;

/**
 * Incrementally decodes an OpenAI-compatible SSE byte/text stream into
 * parsed JSON chunk objects, tolerating: partial lines split across separate
 * `push()` calls (a network read can land mid-line), blank keep-alive lines,
 * and non-`data:` lines (comments, other SSE fields) -- all silently
 * ignored. A `data: [DONE]` line yields the literal string `'[DONE]'`
 * instead of attempting to JSON.parse it.
 */
export class SseDecoder {
  private buffer = '';

  /** Feed one raw text chunk; returns every complete event found so far (possibly empty, possibly more than one if several arrived in one chunk). Any trailing partial line is held internally until the next push() completes it. */
  push(text: string): Array<OpenAiStreamChunk | typeof SSE_DONE> {
    this.buffer += text;
    const lines = this.buffer.split('\n');
    // The last element is either '' (buffer ended exactly on a newline) or a
    // partial line still waiting for the rest -- either way, hold it back.
    this.buffer = lines.pop() ?? '';

    const events: Array<OpenAiStreamChunk | typeof SSE_DONE> = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.length === 0 || !line.startsWith('data:')) continue;
      const payload = line.slice('data:'.length).trim();
      if (payload === SSE_DONE) {
        events.push(SSE_DONE);
        continue;
      }
      try {
        events.push(JSON.parse(payload) as OpenAiStreamChunk);
      } catch {
        // Malformed line -- skip it rather than crash the stream; the model
        // gets another chance on the next chunk/step.
      }
    }
    return events;
  }
}

interface PendingToolCall {
  id?: string;
  name: string;
  args: string;
}

/**
 * Folds a sequence of parsed stream chunks into one step's result: narration
 * text (concatenated `delta.content` fragments, in arrival order) and
 * however many tool calls were in flight, assembled by `index` (parallel
 * tool calls interleave their fragments across chunks -- e.g. index 0's
 * first half, then index 1's first half, then index 0's second half).
 */
export class StepAccumulator {
  private content = '';
  private toolCalls = new Map<number, PendingToolCall>();
  private finishReason: string | null = null;

  /**
   * Folds one parsed chunk in. Returns the newly-arrived content text, if
   * any, so the caller can forward it to `onDelta` -- kept as a return value
   * rather than a callback parameter so this class stays a pure, trivially
   * testable data accumulator with no side effects of its own.
   */
  feed(chunk: OpenAiStreamChunk): string | undefined {
    const choice = chunk.choices?.[0];
    if (!choice) return undefined;

    const delta = choice.delta;
    let deltaText: string | undefined;
    if (delta?.content) {
      this.content += delta.content;
      deltaText = delta.content;
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const existing = this.toolCalls.get(tc.index) ?? { name: '', args: '' };
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.name += tc.function.name;
        if (tc.function?.arguments) existing.args += tc.function.arguments;
        this.toolCalls.set(tc.index, existing);
      }
    }

    if (choice.finish_reason) {
      this.finishReason = choice.finish_reason;
    }

    return deltaText;
  }

  /** True once a `finish_reason` has been seen -- the step is complete. */
  isDone(): boolean {
    return this.finishReason !== null;
  }

  result(): StepResult {
    const toolCalls: AccumulatedToolCall[] = [...this.toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, tc]) => ({ id: tc.id ?? `call_${index}`, name: tc.name, arguments: tc.args }));
    return { content: this.content, toolCalls, finishReason: this.finishReason };
  }
}
