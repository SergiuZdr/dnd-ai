// Wraps one Agent SDK `query()` session in streaming-input mode: a push-queue
// async generator feeds player turns in, a background consume loop turns SDK
// messages into a small callback surface (deltas, tool-use notices, turn
// completion, system notes, friendly errors). One DmSession == one play
// sitting's worth of conversation with the DM.

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  McpSdkServerConfigWithInstance,
  Options,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { loadSettings, resolveModelOption } from '../game/settings';

export type DmErrorKind = 'auth' | 'rate_limit' | 'unknown';

export class DmError extends Error {
  kind: DmErrorKind;
  friendly: string;

  constructor(kind: DmErrorKind, message: string, friendly: string) {
    super(message);
    this.name = 'DmError';
    this.kind = kind;
    this.friendly = friendly;
  }
}

export interface DmSessionCallbacks {
  /** Narration text deltas as they stream. */
  onDelta: (text: string) => void;
  /** The assistant emitted a tool_use block (short name, mcp__dnd__ prefix stripped). */
  onToolUse?: (toolName: string) => void;
  /** Fires once per completed player turn. */
  onTurnComplete: (info: { text: string; costUsd?: number }) => void;
  /** e.g. rate_limit_event notices. */
  onSystemNote?: (note: string) => void;
  onError?: (err: DmError) => void;
  /** Fired for EVERY raw SDK message, before any type-based handling -- wired to --debug logging. */
  onRawMessage?: (msg: unknown) => void;
}

export interface DmSessionConfig {
  systemPrompt: string;
  server: McpSdkServerConfigWithInstance;
  allowedTools: string[];
  model?: string;
  /** Cap on internal agentic-loop turns spent responding to one player message. Default 12. */
  maxTurnsPerMessage?: number;
}

const DEFAULT_MAX_TURNS_PER_MESSAGE = 12;
const MCP_TOOL_PREFIX = 'mcp__dnd__';

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Classifies a thrown/caught error (query construction or the consume loop dying). */
function classifyThrownError(rawMessage: string): DmError {
  if (/login|logged|auth|OAuth|credential/i.test(rawMessage)) {
    return new DmError(
      'auth',
      rawMessage,
      'Not logged in to Claude Code. Run `claude` once in a terminal, log in, then come back.',
    );
  }
  if (/rate.?limit|overloaded|429|usage limit/i.test(rawMessage)) {
    return new DmError(
      'rate_limit',
      rawMessage,
      'The weave is exhausted — the realm needs a short rest. Try again in a few minutes.',
    );
  }
  return new DmError('unknown', rawMessage, rawMessage);
}

function stripDndPrefix(toolName: string): string {
  return toolName.startsWith(MCP_TOOL_PREFIX) ? toolName.slice(MCP_TOOL_PREFIX.length) : toolName;
}

/**
 * Appends `next` to `existing`, inserting a blank-line separator first if
 * `existing` is non-empty and doesn't already end in whitespace -- prevents
 * two text segments from separate 'assistant' messages (a normal tool-loop
 * pattern: narrate, call a tool, narrate more in a follow-up 'assistant'
 * message) from gluing together mid-sentence with zero separator.
 */
export function appendTurnText(existing: string, next: string): string {
  if (existing.length === 0 || /\s$/.test(existing)) return existing + next;
  return `${existing}\n\n${next}`;
}

export class DmSession {
  private readonly config: DmSessionConfig;
  private readonly callbacks: DmSessionCallbacks;

  private activeQuery?: Query;
  private consumeLoopDone?: Promise<void>;

  // Push-queue state for the streaming-input async generator.
  private queue: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;

  private turnText = '';
  private _busy = false;

  constructor(config: DmSessionConfig, callbacks: DmSessionCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
  }

  get busy(): boolean {
    return this._busy;
  }

  private async *inputGenerator(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      if (this.queue.length > 0) {
        // Non-null assertion: length check above guarantees an element.
        yield this.queue.shift()!;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  start(): void {
    // config.model (campaign.modelOverride) wins when a campaign explicitly
    // pins one; otherwise fall back to the player's global settings.json
    // (dmModel: 'default' | 'haiku' | 'sonnet' | 'opus', 'default' meaning
    // "omit the option entirely, use the Claude Code default").
    let model = this.config.model;
    if (model === undefined) {
      const { settings, warning } = loadSettings();
      if (warning) this.callbacks.onSystemNote?.(warning);
      model = resolveModelOption(settings.dmModel);
    }

    const options: Options = {
      settingSources: [],
      tools: [],
      allowedTools: this.config.allowedTools,
      mcpServers: { dnd: this.config.server },
      includePartialMessages: true,
      systemPrompt: this.config.systemPrompt,
      maxTurns: this.config.maxTurnsPerMessage ?? DEFAULT_MAX_TURNS_PER_MESSAGE,
      ...(model !== undefined ? { model } : {}),
    };

    try {
      this.activeQuery = query({ prompt: this.inputGenerator(), options });
    } catch (err) {
      this.failSession(err);
      this.consumeLoopDone = Promise.resolve();
      return;
    }

    this.consumeLoopDone = this.consume();
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.activeQuery!) {
        this.callbacks.onRawMessage?.(message);
        switch (message.type) {
          case 'stream_event': {
            const event = message.event;
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              this.callbacks.onDelta(event.delta.text);
            }
            break;
          }

          case 'assistant': {
            for (const block of message.message.content) {
              if (block.type === 'tool_use') {
                this.callbacks.onToolUse?.(stripDndPrefix(block.name));
              } else if (block.type === 'text') {
                this.turnText = appendTurnText(this.turnText, block.text);
              }
            }
            break;
          }

          case 'result': {
            if (message.subtype === 'success') {
              this.callbacks.onTurnComplete({
                text: this.turnText,
                costUsd: message.total_cost_usd,
              });
            } else {
              const joined =
                message.errors.join('; ') || 'The Dungeon Master encountered an unknown error.';
              this.callbacks.onError?.(new DmError('unknown', joined, joined));
            }
            this.turnText = '';
            this._busy = false;
            break;
          }

          case 'rate_limit_event': {
            this.callbacks.onSystemNote?.(`Rate limit status: ${message.rate_limit_info.status}`);
            break;
          }

          default:
            // ~40-variant union; anything we don't explicitly handle is ignored.
            break;
        }
      }
    } catch (err) {
      this.failSession(err);
    }
  }

  private failSession(err: unknown): void {
    this._busy = false;
    this.callbacks.onError?.(classifyThrownError(errorMessageOf(err)));
  }

  send(playerText: string): void {
    this._busy = true;
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: playerText },
      parent_tool_use_id: null,
    });
    if (this.wake) {
      const wake = this.wake;
      this.wake = undefined;
      wake();
    }
  }

  async interrupt(): Promise<void> {
    if (!this.activeQuery) return;
    try {
      await this.activeQuery.interrupt();
    } catch (err) {
      if (!/not support/i.test(errorMessageOf(err))) {
        throw err;
      }
    }
  }

  async end(): Promise<void> {
    this.closed = true;
    if (this.wake) {
      const wake = this.wake;
      this.wake = undefined;
      wake();
    }
    if (this.consumeLoopDone) {
      await this.consumeLoopDone;
    }
  }
}
