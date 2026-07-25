// A sibling of DmSession (src/ai/dm.ts) that drives an OpenAI-compatible
// `/v1/chat/completions` endpoint (Ollama / OpenRouter / self-host) instead
// of the Claude Agent SDK, so a play sitting can spend zero Claude tokens
// (P1). Implements the exact same DmSessionLike surface (start/send/
// interrupt/end/busy) and fires the exact same DmSessionCallbacks the
// controller already wires up -- selecting this backend is purely a
// settings.json choice (see game/controller.ts's default sessionFactory);
// nothing about the controller, bridge, or UI changes.
//
// The agentic loop (PR-2): send() appends the player's message, then loops
// POSTing the running message list (+ tool schemas) with stream:true. Each
// POST is one "step": content deltas stream out via onDelta, and any
// `tool_calls` are accumulated by index (openaiStream.ts). When a step ends
// with tool calls, each is validated/repaired (argRepair.ts) and invoked via
// the EXACT SAME handler createDmTools() built for the Claude backend --
// this is also what makes roller:'player' rolls pause for real: the handler
// awaits hooks.interactiveRoll, and this loop awaits the handler, so nothing
// else needs to know this is a different backend. The tool's result is
// pushed back as a `role:'tool'` message and the loop continues. When a step
// ends with no tool calls, the turn is complete.

import { DmError, appendTurnText } from './dm';
import type { DmSessionCallbacks, DmSessionConfig } from './dm';
import { loadSettings } from '../game/settings';
import type { OpenAiSettings } from '../game/settings';
import { toolsToOpenAiSchemas } from './toolSchema';
import type { OpenAiFunctionToolSchema } from './toolSchema';
import { repairAndValidateArgs } from './argRepair';
import { SseDecoder, StepAccumulator, SSE_DONE } from './openaiStream';
import type { AccumulatedToolCall, OpenAiStreamChunk, StepResult } from './openaiStream';
import {
  fetchWithRetry,
  isAbortError,
  errorMessageOf,
  classifyHttpError,
  classifyNetworkError,
  safeReadText,
} from './openaiHttp';

const DEFAULT_MAX_TURNS_PER_MESSAGE = 12;

type ToolMessageCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolMessageCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Minimal shape of an MCP CallToolResult -- avoids importing the type from @modelcontextprotocol/sdk just to read .content/.isError (mirrors ai/tools.ts's own toCallToolResult return shape). */
interface CallToolResultLike {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function extractText(result: CallToolResultLike): string {
  return result.content.map((c) => c.text ?? '').join('');
}

export interface OpenAiDmSessionOptions {
  /** Test seam: forwarded to loadSettings() instead of the real process.cwd() settings.json -- so tests can exercise the agentic loop without touching the developer's actual repo-root settings.json. Defaults to loadSettings()'s own default (process.cwd()) in production. */
  settingsBaseDir?: string;
}

export class OpenAiDmSession {
  private readonly config: DmSessionConfig;
  private readonly callbacks: DmSessionCallbacks;
  private readonly opts?: OpenAiDmSessionOptions;

  private messages: ChatMessage[] = [];
  private toolsByName = new Map<string, NonNullable<DmSessionConfig['tools']>[number]>();
  private toolSchemas: OpenAiFunctionToolSchema[] = [];

  private model = '';
  private baseUrl = '';
  private apiKey: string | undefined;
  private maxSteps = DEFAULT_MAX_TURNS_PER_MESSAGE;

  private abortController?: AbortController;
  private runTurnPromise?: Promise<void>;
  private closed = false;
  private _busy = false;

  constructor(config: DmSessionConfig, callbacks: DmSessionCallbacks, opts?: OpenAiDmSessionOptions) {
    this.config = config;
    this.callbacks = callbacks;
    this.opts = opts;
  }

  get busy(): boolean {
    return this._busy;
  }

  start(): void {
    // config.model (campaign.modelOverride) wins when a campaign explicitly
    // pins one; otherwise fall back to the player's global settings.json --
    // same precedence DmSession uses for the Claude backend.
    const { settings, warning } = loadSettings(this.opts?.settingsBaseDir);
    if (warning) this.callbacks.onSystemNote?.(warning);

    const openai: OpenAiSettings = settings.openai;
    this.model = this.config.model ?? openai.model;
    this.baseUrl = openai.baseUrl.replace(/\/+$/, '');
    this.maxSteps = this.config.maxTurnsPerMessage ?? DEFAULT_MAX_TURNS_PER_MESSAGE;

    this.apiKey = undefined;
    if (openai.apiKeyEnv) {
      const key = process.env[openai.apiKeyEnv];
      if (key && key.length > 0) {
        this.apiKey = key;
      } else {
        this.callbacks.onSystemNote?.(
          `openai.apiKeyEnv is set to "${openai.apiKeyEnv}" but that environment variable is empty or unset — requests will be sent without an API key.`,
        );
      }
    }

    const tools = this.config.tools ?? [];
    this.toolsByName = new Map(tools.map((t) => [t.name, t]));
    this.toolSchemas = toolsToOpenAiSchemas(tools);

    this.messages = [{ role: 'system', content: this.config.systemPrompt }];
  }

  send(playerText: string): void {
    this._busy = true;
    this.messages.push({ role: 'user', content: playerText });
    this.runTurnPromise = this.runTurn().catch((err) => {
      // runTurn() is written to catch and report its own errors -- this is
      // a last-resort safety net for a truly unexpected bug, so a session
      // never gets stuck "busy" forever.
      this._busy = false;
      this.callbacks.onError?.(classifyNetworkError(err));
    });
  }

  async interrupt(): Promise<void> {
    this.abortController?.abort();
    if (this.runTurnPromise) {
      try {
        await this.runTurnPromise;
      } catch {
        // Already handled inside runTurn()/its catch above.
      }
    }
    this._busy = false;
  }

  async end(): Promise<void> {
    this.closed = true;
    this.abortController?.abort();
    if (this.runTurnPromise) {
      try {
        await this.runTurnPromise;
      } catch {
        // Already handled.
      }
    }
  }

  private async runTurn(): Promise<void> {
    try {
      let turnText = '';

      for (let step = 0; step < this.maxSteps; step++) {
        if (this.closed) return;

        const abortController = new AbortController();
        this.abortController = abortController;

        let response: Response;
        try {
          response = await this.postChatCompletion(abortController.signal);
        } catch (err) {
          if (isAbortError(err)) return;
          this.callbacks.onError?.(classifyNetworkError(err));
          return;
        }

        if (!response.ok) {
          const bodyText = await safeReadText(response);
          this.callbacks.onError?.(classifyHttpError(response.status, bodyText));
          return;
        }
        if (!response.body) {
          this.callbacks.onError?.(
            new DmError('unknown', 'empty response body', 'The Dungeon Master returned an empty response.'),
          );
          return;
        }

        let stepResult: StepResult;
        try {
          stepResult = await this.consumeStream(response.body);
        } catch (err) {
          if (isAbortError(err)) return;
          this.callbacks.onError?.(classifyNetworkError(err));
          return;
        }
        this.abortController = undefined;

        // Stream truncation (NFR 6.2): if the connection closed without a
        // finish_reason AND nothing at all came through, that's a real
        // failure, not a turn to quietly complete with empty text.
        if (stepResult.finishReason === null && stepResult.content.length === 0 && stepResult.toolCalls.length === 0) {
          this.callbacks.onError?.(
            new DmError(
              'unknown',
              'stream ended with no content',
              'The Dungeon Master returned nothing — please try again.',
            ),
          );
          return;
        }

        if (stepResult.content.length > 0) {
          turnText = appendTurnText(turnText, stepResult.content);
        }

        if (stepResult.toolCalls.length > 0) {
          this.messages.push(this.assistantMessageFor(stepResult));
          for (const call of stepResult.toolCalls) {
            this.callbacks.onToolUse?.(call.name);
            const resultText = await this.executeToolCall(call);
            this.messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
          }
          continue; // one more step: let the model react to the tool result(s)
        }

        // No tool calls -- this step's completion ends the turn.
        this.callbacks.onTurnComplete({ text: turnText });
        return;
      }

      // Hit the internal step cap without a natural stop -- end the turn
      // gracefully with whatever was narrated rather than hanging forever
      // (mirrors the Claude Agent SDK's own maxTurns cap).
      this.callbacks.onSystemNote?.('(reached the internal turn-step limit — ending the turn)');
      this.callbacks.onTurnComplete({ text: turnText });
    } finally {
      this._busy = false;
      this.abortController = undefined;
    }
  }

  private assistantMessageFor(step: StepResult): ChatMessage {
    return {
      role: 'assistant',
      content: step.content,
      tool_calls: step.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }

  /** Never throws -- an unknown tool, unparsable JSON, unrepairable args, or a handler throw all become an `ERROR: ...` string the model sees as this tool call's result (PR-7). */
  private async executeToolCall(call: AccumulatedToolCall): Promise<string> {
    const tool = this.toolsByName.get(call.name);
    if (!tool) {
      return `ERROR: unknown tool "${call.name}"`;
    }

    let rawArgs: unknown;
    try {
      rawArgs = call.arguments.trim().length === 0 ? {} : JSON.parse(call.arguments);
    } catch (err) {
      return `ERROR: could not parse arguments for ${call.name} as JSON: ${errorMessageOf(err)}`;
    }

    const repaired = repairAndValidateArgs(tool, rawArgs);
    if (!repaired.ok) {
      return `ERROR: ${repaired.error}`;
    }

    try {
      const result = (await tool.handler(repaired.args, undefined)) as CallToolResultLike;
      return extractText(result);
    } catch (err) {
      return `ERROR: tool ${call.name} threw: ${errorMessageOf(err)}`;
    }
  }

  private async postChatCompletion(signal: AbortSignal): Promise<Response> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const body = JSON.stringify({
      model: this.model,
      messages: this.messages,
      tools: this.toolSchemas,
      tool_choice: 'auto',
      stream: true,
    });

    return fetchWithRetry(url, { method: 'POST', headers, body, signal });
  }

  private async consumeStream(body: ReadableStream<Uint8Array>): Promise<StepResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    const sse = new SseDecoder();
    const acc = new StepAccumulator();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const events = sse.push(text);

        let stepDone = false;
        for (const event of events) {
          this.callbacks.onRawMessage?.(event);
          if (event === SSE_DONE) {
            stepDone = true;
            break;
          }
          const delta = acc.feed(event as OpenAiStreamChunk);
          if (delta) this.callbacks.onDelta(delta);
        }
        if (stepDone || acc.isDone()) {
          try {
            await reader.cancel();
          } catch {
            // Best-effort -- the request is done either way.
          }
          break;
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Already released (e.g. by the cancel() above).
      }
    }

    return acc.result();
  }
}
