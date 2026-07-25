// The THIRD DmSession backend: a two-model "referee + narrator" split so
// mechanics stay as reliable as OpenAiDmSession's single-model agentic loop,
// while narration can run on a separate, more permissive/uncensored model --
// both via the SAME free OpenAI-compatible endpoint (settings.openai.baseUrl
// / apiKeyEnv), just two model ids. Implements the exact same DmSessionLike
// surface (start/send/interrupt/end/busy) and fires the exact same
// DmSessionCallbacks the controller already wires up -- selecting this
// backend is purely a settings.json choice (dmBackend:"dual", see
// game/controller.ts's default sessionFactory); nothing about the
// controller, bridge, or UI changes.
//
// Per player turn (send()), TWO phases run in sequence:
//
//  1. REFEREE phase -- an agentic tool loop against the referee model,
//     structurally identical to OpenAiDmSession's loop (same SseDecoder/
//     StepAccumulator/repairAndValidateArgs/toolsToOpenAiSchemas machinery
//     from openaiStream.ts/argRepair.ts/toolSchema.ts, same executeToolCall
//     shape, same tool.handler(...) call so roller:'player' rolls still
//     await hooks.interactiveRoll and pause the turn exactly as today). The
//     one behavioral difference: the referee's streamed content is NEVER
//     forwarded to onDelta (it's an internal beat sheet, not player-facing
//     narration) -- but onToolUse still fires per tool call (so
//     onToolActivity/the dice UI keep working; onDiceRoll/onRollPrompt are
//     wired at the tools.ts hooks level in game/controller.ts and fire
//     regardless of which backend calls tool.handler()). When a step ends
//     with no tool calls, that final message is the beat sheet, and the
//     turn's tool calls have been collected into a ToolOutcomeRecord[] --
//     each entry keeps the engine's own fully-descriptive result message
//     (e.g. "🎲 d20+3 (Force the door) → [15]+3 = 18 vs DC 13 — ✓ success"),
//     which already states rolls/dc/success and deltas/before/after in
//     plain English, so nothing needs to be re-derived for the narrator.
//
//  2. NARRATOR phase -- one streaming chat completion against the narrator
//     model, no tools at all: the request omits `tools`/`tool_choice`
//     entirely. The prompt is the narrator system prompt + recent narrator
//     history (bounded -- see MAX_NARRATOR_HISTORY_MESSAGES) + a single user
//     message combining the scene context/player's cue, the referee's beat
//     sheet, and the formatted tool-outcome record (buildNarratorUserPrompt).
//     Its streamed content IS forwarded via onDelta (this is what the player
//     sees), and onTurnComplete fires with the finished narration once the
//     stream ends.
//
// A narrator-phase failure (network/HTTP error) surfaces via onError same as
// any other DM error -- note the referee's tool calls have already mutated
// engine state by that point (irreversible, same as any tool call already
// applied under any backend); the player sees the friendly error and can
// keep playing on their next action once the endpoint recovers.

import { DmError, appendTurnText } from './dm';
import type { DmSessionCallbacks, DmSessionConfig } from './dm';
import { loadSettings } from '../game/settings';
import type { OpenAiSettings } from '../game/settings';
import type { GameState } from '../game/state';
import { toolsToOpenAiSchemas } from './toolSchema';
import type { OpenAiFunctionToolSchema } from './toolSchema';
import { repairAndValidateArgs } from './argRepair';
import { refereeSystemPrompt, narratorSystemPrompt } from './prompts';
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
// Bounds the narrator's own running history (separate from the referee's,
// which -- like OpenAiDmSession's -- is left to grow for the life of one
// sitting; the controller's chronicle rotation is what eventually resets
// both by ending the session and constructing a fresh one). 12 messages = 6
// user/assistant turn-pairs of recent narration -- plenty for tonal/style
// continuity without the narrator prompt growing unbounded within one
// sitting.
const MAX_NARRATOR_HISTORY_MESSAGES = 12;

type ToolMessageCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

type RefereeMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolMessageCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

type NarratorMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** Minimal shape of an MCP CallToolResult -- avoids importing the type from @modelcontextprotocol/sdk just to read .content/.isError (mirrors ai/tools.ts's own toCallToolResult return shape; identical to openaiDm.ts's local copy). */
interface CallToolResultLike {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function extractText(result: CallToolResultLike): string {
  return result.content.map((c) => c.text ?? '').join('');
}

/**
 * One tool call's outcome during the referee phase, captured so the
 * narrator gets a faithful, structured record of what mechanically happened
 * this turn -- rolls (reason/dc/success live inside resultText, which is the
 * engine's own formatted message -- see engine.ts's formatRollMessage etc.),
 * gold/xp/item/damage/heal deltas, and location/quest/npc changes (same
 * story: the engine's resultText already states them in full).
 */
export interface ToolOutcomeRecord {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  resultText: string;
}

/** Renders a turn's ToolOutcomeRecord[] into the plain-text block the narrator's prompt embeds -- one line per tool call, in call order. */
export function formatToolOutcomes(records: ToolOutcomeRecord[]): string {
  if (records.length === 0) return '(no tool calls this turn -- nothing mechanical changed)';
  return records.map((r) => `- ${r.tool}: ${r.ok ? r.resultText : `FAILED -- ${r.resultText}`}`).join('\n');
}

/**
 * Extracts a short "recent story" hint from the incoming send() text for the
 * narrator's continuity when its own history is empty (session start, or
 * right after a chronicle rotation) -- pulls the STORY SO FAR/RECENT
 * CHAPTERS section out of buildContextBrief's fixed format (ai/prompts.ts)
 * when present; undefined otherwise (a plain mid-sitting turn, or the
 * opening/new-hero prompts, none of which contain that marker).
 */
function extractBriefHint(playerText: string): string | undefined {
  const match = playerText.match(/STORY SO FAR:[\s\S]*?(?=\nCURRENT STATE)/);
  return match ? match[0].trim() : undefined;
}

/** Strips the referee-only <system-reminder>...</system-reminder> mechanics nudge (ai/prompts.ts's withMechanicsReminder) out of the incoming player text -- the narrator has no use for DM bookkeeping instructions and shouldn't see them. */
function stripMechanicsReminder(text: string): string {
  return text.replace(/\n*<system-reminder>[\s\S]*?<\/system-reminder>/, '').trim();
}

/**
 * Builds the narrator's one user message for this turn: scene context/the
 * player's cue (the incoming send() text, cleaned of referee-only noise,
 * plus a story-so-far hint when present) + the referee's beat sheet + the
 * formatted tool-outcome record. Exported for direct unit testing.
 */
/**
 * The hero's real numbers, straight off the engine, as the narrator's last
 * line of defence against inventing mechanics.
 *
 * Why this exists: the narrator has no tools and no view of the engine, so on
 * a turn where the referee called nothing it used to receive only the player's
 * stated INTENT ("I drink a tincture to heal") and a note that nothing
 * happened -- and would dutifully dramatise the intent as success, writing
 * "your HP climbs to eleven of thirteen" while the sheet still read 7/13 and
 * the tincture was still in the pack. Prose is what the player believes, so
 * that silently broke the game's core promise that the engine owns the
 * numbers. Handing over the post-turn truth makes the contradiction
 * impossible to miss.
 */
export function formatHeroGroundTruth(state: GameState): string {
  const c = state.character;
  const items = c.inventory.length
    ? c.inventory.map((i) => `${i.name} x${i.qty}`).join(', ')
    : '(nothing)';
  return [
    `HP ${c.hp}/${c.maxHp} | AC ${c.ac} | gold ${c.gold} | XP ${c.xp} | luck ${c.luck} | level ${c.level}`,
    `Carrying: ${items}`,
    `Location: ${state.world.location}`,
  ].join('\n');
}

export function buildNarratorUserPrompt(
  playerText: string,
  beatSheet: string,
  outcomes: ToolOutcomeRecord[],
  state?: GameState,
): string {
  const cleaned = stripMechanicsReminder(playerText);
  const briefHint = extractBriefHint(playerText);
  const sceneContext = briefHint ? `${briefHint}\n\n${cleaned}` : cleaned;

  const groundTruth = state
    ? `\n[HERO SHEET -- GROUND TRUTH, ALREADY INCLUDING THIS TURN'S CHANGES]
${formatHeroGroundTruth(state)}
`
    : '';

  // Spelled out explicitly because this is precisely the case the narrator got
  // wrong: an attempted-but-unresolved action must read as unresolved, not as
  // quiet success.
  const nothingHappened =
    outcomes.length === 0
      ? `\nNOTE: the referee resolved NOTHING mechanical this turn. If the player attempted something mechanical (drinking a potion, healing, attacking, looting, buying), it has NOT taken effect: do not describe it succeeding, do not state any new HP/gold/item/XP value, and do not describe an item being used up. Carry the scene with description, dialogue and atmosphere instead, and let the attempt stay unresolved.\n`
      : '';

  return `[SCENE CONTEXT / PLAYER'S CUE]
${sceneContext || '(the story is just beginning)'}

[MECHANICAL FACTS THIS TURN -- from the referee; do not contradict or invent beyond this]
${beatSheet || '(the referee reported nothing unusual this turn)'}

[TOOL OUTCOMES THIS TURN]
${formatToolOutcomes(outcomes)}
${groundTruth}${nothingHappened}
Write the narration now, in your voice, ending with "What do you do?" unless the scene has just ended in death.`;
}

export interface DualModelDmSessionOptions {
  /** Test seam: forwarded to loadSettings() instead of the real process.cwd() settings.json -- see OpenAiDmSessionOptions for the identical rationale. */
  settingsBaseDir?: string;
}

export class DualModelDmSession {
  private readonly config: DmSessionConfig;
  private readonly callbacks: DmSessionCallbacks;
  private readonly opts?: DualModelDmSessionOptions;

  private refereeMessages: RefereeMessage[] = [];
  private narratorHistory: NarratorMessage[] = [];
  private narratorSystemPromptText = '';

  private toolsByName = new Map<string, NonNullable<DmSessionConfig['tools']>[number]>();
  private toolSchemas: OpenAiFunctionToolSchema[] = [];

  private refereeModel = '';
  private narratorModel = '';
  private baseUrl = '';
  private apiKey: string | undefined;
  private maxSteps = DEFAULT_MAX_TURNS_PER_MESSAGE;

  /** The exact text passed to the most recent send() -- carried into the narrator phase so its prompt can reference the same scene context/player's cue the referee saw. */
  private lastPlayerText = '';
  /** Per-turn latch for the zero-tool nudge in runRefereePhase() -- reset at the top of every referee phase so the retry is offered once per player turn, never once per session. */
  private retriedEmptyTurn = false;

  private abortController?: AbortController;
  private runTurnPromise?: Promise<void>;
  private closed = false;
  private _busy = false;

  constructor(config: DmSessionConfig, callbacks: DmSessionCallbacks, opts?: DualModelDmSessionOptions) {
    this.config = config;
    this.callbacks = callbacks;
    this.opts = opts;
  }

  get busy(): boolean {
    return this._busy;
  }

  start(): void {
    const { settings, warning } = loadSettings(this.opts?.settingsBaseDir);
    if (warning) this.callbacks.onSystemNote?.(warning);

    const openai: OpenAiSettings = settings.openai;
    // config.model (campaign.modelOverride) is treated as a referee pin --
    // it's the closest existing analogue to "the model" a per-campaign
    // override historically meant for the single-model backends. The
    // narrator is a distinct, dedicated setting (openai.narratorModel) that
    // a campaign override doesn't attempt to steer.
    this.refereeModel = this.config.model ?? openai.model;
    this.narratorModel = openai.narratorModel ?? openai.model;
    if (!openai.narratorModel) {
      this.callbacks.onSystemNote?.(
        "openai.narratorModel is not set — narration will reuse openai.model (the referee's model) for now. " +
          'Set openai.narratorModel (or the DND_OPENAI_NARRATOR_MODEL env var) to use a separate, more permissive narrator model.',
      );
    }
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

    const contentRating = this.config.contentRating ?? 'PG-13';
    this.refereeMessages = [{ role: 'system', content: refereeSystemPrompt(contentRating) }];
    this.narratorSystemPromptText = narratorSystemPrompt(contentRating);
    this.narratorHistory = [];
  }

  send(playerText: string): void {
    this._busy = true;
    this.lastPlayerText = playerText;
    this.refereeMessages.push({ role: 'user', content: playerText });
    this.runTurnPromise = this.runTurn().catch((err) => {
      // Last-resort safety net -- runTurn()/its phases are written to catch
      // and report their own errors, so a session never gets stuck "busy".
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
      if (this.closed) return;
      const referee = await this.runRefereePhase();
      if (!referee || this.closed) return; // error/abort already reported by the referee phase itself
      await this.runNarratorPhase(referee);
    } finally {
      this._busy = false;
      this.abortController = undefined;
    }
  }

  // -- Phase 1: REFEREE ----------------------------------------------------

  /** Runs the referee's agentic tool loop to completion. Returns undefined on error/abort (already reported via callbacks); otherwise the beat sheet + this turn's tool-outcome record. */
  private async runRefereePhase(): Promise<{ beatSheet: string; outcomes: ToolOutcomeRecord[] } | undefined> {
    let beatSheet = '';
    const outcomes: ToolOutcomeRecord[] = [];
    this.retriedEmptyTurn = false;

    for (let step = 0; step < this.maxSteps; step++) {
      if (this.closed) return undefined;

      const abortController = new AbortController();
      this.abortController = abortController;

      let response: Response;
      try {
        response = await this.postRefereeCompletion(abortController.signal);
      } catch (err) {
        if (isAbortError(err)) return undefined;
        this.callbacks.onError?.(classifyNetworkError(err));
        return undefined;
      }

      if (!response.ok) {
        const bodyText = await safeReadText(response);
        this.callbacks.onError?.(classifyHttpError(response.status, bodyText));
        return undefined;
      }
      if (!response.body) {
        this.callbacks.onError?.(
          new DmError('unknown', 'empty response body', 'The Dungeon Master (referee) returned an empty response.'),
        );
        return undefined;
      }

      let stepResult: StepResult;
      try {
        stepResult = await this.consumeStream(response.body, { forwardDeltas: false });
      } catch (err) {
        if (isAbortError(err)) return undefined;
        this.callbacks.onError?.(classifyNetworkError(err));
        return undefined;
      }
      this.abortController = undefined;

      // Stream truncation (mirrors OpenAiDmSession's NFR 6.2 handling).
      if (stepResult.finishReason === null && stepResult.content.length === 0 && stepResult.toolCalls.length === 0) {
        this.callbacks.onError?.(
          new DmError('unknown', 'stream ended with no content', 'The Dungeon Master (referee) returned nothing — please try again.'),
        );
        return undefined;
      }

      if (stepResult.content.length > 0) {
        beatSheet = appendTurnText(beatSheet, stepResult.content);
      }

      if (stepResult.toolCalls.length > 0) {
        this.refereeMessages.push(this.assistantMessageFor(stepResult));
        for (const call of stepResult.toolCalls) {
          this.callbacks.onToolUse?.(call.name);
          const outcome = await this.executeToolCall(call);
          outcomes.push({ tool: call.name, args: outcome.args, ok: outcome.ok, resultText: outcome.resultText });
          this.refereeMessages.push({ role: 'tool', tool_call_id: call.id, content: outcome.resultText });
        }
        continue; // one more step: let the referee react to the tool result(s)
      }

      // No tool calls this step. If the referee has called NOTHING all turn,
      // give it exactly one chance to notice and fix that before we commit.
      //
      // This is the failure that motivated the retry: the player wrote "I use
      // one of Aldric's tinctures to heal", the referee produced only a beat
      // sheet, and the narrator then dramatised the heal as though it had
      // happened -- HP and inventory never moved. A 70B referee on a free
      // endpoint skips tool calls often enough that "ask again, once" is worth
      // the extra request; plenty of turns are legitimately mechanics-free
      // (pure conversation, looking around), so the nudge explicitly permits
      // standing pat and we accept whatever comes back either way.
      if (outcomes.length === 0 && !this.retriedEmptyTurn) {
        this.retriedEmptyTurn = true;
        this.refereeMessages.push({ role: 'assistant', content: stepResult.content });
        this.refereeMessages.push({
          role: 'user',
          content:
            'You ended that turn without calling a single tool. Re-read the player\'s action: if ANYTHING mechanical happened — the hero drank/used/consumed an item, healed, rested, took damage, attacked, gained or spent gold, gained or lost an item, earned XP, or moved somewhere new — call the matching tools NOW (heal, apply_damage, remove_item, add_item, modify_gold, award_xp, set_location, roll_dice...). The player\'s screen only ever shows what these tools record, so an unrecorded change simply did not happen. If the turn genuinely involved nothing mechanical, reply with your beat sheet again and call nothing.',
        });
        continue;
      }

      // No tool calls -- this step's completion IS the beat sheet.
      return { beatSheet, outcomes };
    }

    // Hit the internal step cap without a natural stop -- proceed to the
    // narrator with whatever beat sheet/outcomes were gathered rather than
    // hanging forever (mirrors OpenAiDmSession's own maxTurns cap).
    this.callbacks.onSystemNote?.('(reached the internal referee turn-step limit — ending the turn)');
    return { beatSheet, outcomes };
  }

  private assistantMessageFor(step: StepResult): RefereeMessage {
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

  /** Never throws -- an unknown tool, unparsable JSON, unrepairable args, or a handler throw all become an ERROR: ... result string (same PR-7 contract as OpenAiDmSession.executeToolCall), plus the structured {ok, args} the outcome record needs. */
  private async executeToolCall(call: AccumulatedToolCall): Promise<{ resultText: string; ok: boolean; args: Record<string, unknown> }> {
    const tool = this.toolsByName.get(call.name);
    if (!tool) {
      return { resultText: `ERROR: unknown tool "${call.name}"`, ok: false, args: {} };
    }

    let rawArgs: unknown;
    try {
      rawArgs = call.arguments.trim().length === 0 ? {} : JSON.parse(call.arguments);
    } catch (err) {
      return { resultText: `ERROR: could not parse arguments for ${call.name} as JSON: ${errorMessageOf(err)}`, ok: false, args: {} };
    }

    const repaired = repairAndValidateArgs(tool, rawArgs);
    if (!repaired.ok) {
      const fallbackArgs = typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
      return { resultText: `ERROR: ${repaired.error}`, ok: false, args: fallbackArgs };
    }

    try {
      const result = (await tool.handler(repaired.args, undefined)) as CallToolResultLike;
      return { resultText: extractText(result), ok: !result.isError, args: repaired.args };
    } catch (err) {
      return { resultText: `ERROR: tool ${call.name} threw: ${errorMessageOf(err)}`, ok: false, args: repaired.args };
    }
  }

  private async postRefereeCompletion(signal: AbortSignal): Promise<Response> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const body = JSON.stringify({
      model: this.refereeModel,
      messages: this.refereeMessages,
      tools: this.toolSchemas,
      tool_choice: 'auto',
      stream: true,
    });

    return fetchWithRetry(url, { method: 'POST', headers, body, signal });
  }

  // -- Phase 2: NARRATOR ----------------------------------------------------

  private async runNarratorPhase(referee: { beatSheet: string; outcomes: ToolOutcomeRecord[] }): Promise<void> {
    // Snapshot AFTER the referee phase, so it reflects this turn's tool calls.
    const userPrompt = buildNarratorUserPrompt(
      this.lastPlayerText,
      referee.beatSheet,
      referee.outcomes,
      this.config.stateSnapshot?.(),
    );
    const requestMessages: NarratorMessage[] = [
      { role: 'system', content: this.narratorSystemPromptText },
      ...this.narratorHistory,
      { role: 'user', content: userPrompt },
    ];

    const abortController = new AbortController();
    this.abortController = abortController;

    let response: Response;
    try {
      response = await this.postNarratorCompletion(requestMessages, abortController.signal);
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
        new DmError('unknown', 'empty response body', 'The Dungeon Master (narrator) returned an empty response.'),
      );
      return;
    }

    let stepResult: StepResult;
    try {
      stepResult = await this.consumeStream(response.body, { forwardDeltas: true });
    } catch (err) {
      if (isAbortError(err)) return;
      this.callbacks.onError?.(classifyNetworkError(err));
      return;
    }
    this.abortController = undefined;

    if (stepResult.finishReason === null && stepResult.content.length === 0) {
      this.callbacks.onError?.(
        new DmError('unknown', 'stream ended with no content', 'The Dungeon Master (narrator) returned nothing — please try again.'),
      );
      return;
    }

    const narration = stepResult.content;
    this.narratorHistory.push({ role: 'user', content: userPrompt }, { role: 'assistant', content: narration });
    this.trimNarratorHistory();

    this.callbacks.onTurnComplete({ text: narration });
  }

  private async postNarratorCompletion(messages: NarratorMessage[], signal: AbortSignal): Promise<Response> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    // Deliberately NO `tools`/`tool_choice` field -- the narrator must never
    // call a tool or invent mechanics; omitting the field entirely (rather
    // than sending an empty array) makes that structurally obvious in the
    // request itself.
    const body = JSON.stringify({
      model: this.narratorModel,
      messages,
      stream: true,
    });

    return fetchWithRetry(url, { method: 'POST', headers, body, signal });
  }

  private trimNarratorHistory(): void {
    if (this.narratorHistory.length > MAX_NARRATOR_HISTORY_MESSAGES) {
      this.narratorHistory.splice(0, this.narratorHistory.length - MAX_NARRATOR_HISTORY_MESSAGES);
    }
  }

  // -- Shared SSE stream consumption ---------------------------------------

  /**
   * Shared by both phases -- identical decode/accumulate loop as
   * OpenAiDmSession's consumeStream (same SseDecoder/StepAccumulator), but
   * parameterized on whether to forward content deltas to onDelta: the
   * referee's beat sheet streams internally only (forwardDeltas: false --
   * it is never player-facing), while the narrator's prose IS what the
   * player sees (forwardDeltas: true).
   */
  private async consumeStream(body: ReadableStream<Uint8Array>, opts: { forwardDeltas: boolean }): Promise<StepResult> {
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
          if (delta && opts.forwardDeltas) this.callbacks.onDelta(delta);
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
