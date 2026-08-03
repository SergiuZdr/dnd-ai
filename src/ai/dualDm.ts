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

/**
 * How long a stream may produce NOTHING before the turn is declared dead (see
 * the stall watchdog on DualModelDmSession). Generous on purpose: free-tier
 * models routinely take 30-60s to emit their first token, and killing a turn
 * that was merely thinking would be a worse bug than the hang it prevents.
 * Silence past this is not slowness, it is a stream that has stopped.
 */
export const STREAM_STALL_TIMEOUT_MS = 90_000;

/**
 * The narrator returning an empty stream is a known, intermittent free-model
 * failure (it killed a turn outright in a live playtest, and had already forced
 * one model swap). It costs one cheap request to ask again, and unlike the
 * referee phase there is no tool state to replay -- so the turn is retried once
 * before the player is told it failed.
 */
const NARRATOR_EMPTY_RETRIES = 2;

/**
 * Words a referee beat sheet uses when an enemy stops fighting. Kept to plain,
 * unambiguous outcome verbs -- "wounded", "bleeding", "staggered" are all
 * deliberately absent, because a foe who is merely hurt has not been defeated
 * and nudging for defeat_foe there would teach the referee to hand out XP mid-fight.
 */
const FOE_DOWN_RE =
  /\b(kill(?:s|ed)?|slain|slays?|dead|dies|died|defeat(?:s|ed)?|cut down|struck down|knocked out|unconscious|surrender(?:s|ed)?|flees|fled|routed|eliminated|lifeless|collapses|slumps|drops? dead|falls? (?:dead|lifeless)|no longer a threat|is down|goes down)\b/i;

/**
 * Labels the referee gives a roll when someone is swinging at someone. Used as
 * the structural trigger for the missing combat-consequence nudge, covering
 * blows in both directions: a hero attack that connects should end with a
 * damaged or defeated foe, and an enemy attack that connects should end with
 * apply_damage. Keying off the mechanical verdict rather than the beat sheet's
 * wording is the whole point -- the first version of this check read the prose
 * and missed a kill that was worded "collapses lifelessly".
 */
const ATTACK_LABEL_RE = /\b(attack|shot|shoot|strike|swing|stab|slash|thrust|fire[sd]?|loose[sd]?|arrow|blade|blow|melee|ranged)\b/i;

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

/**
 * True when this turn contains a hero attack roll that HIT. The engine's own
 * roll message carries the verdict ("-- ✓ success"), so this reads the
 * mechanical result and only uses the label to decide whether the roll was an
 * attack at all.
 */
export function landedAnAttack(outcomes: ToolOutcomeRecord[]): boolean {
  return outcomes.some((o) => {
    if (o.tool !== 'roll_dice' || !o.ok) return false;
    if (!/success/i.test(o.resultText)) return false;
    const label = typeof o.args.reason === 'string' ? o.args.reason : '';
    return ATTACK_LABEL_RE.test(label);
  });
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
/**
 * Plain-language reading of the hero's HP, because a bare "HP 5/12" was not
 * enough: handed exactly that, the narrator wrote the hero's heartbeat
 * "growing slower and weaker" fading into "hollow silence" -- a death scene --
 * on a turn where the enemy's attack had actually MISSED. Spelling the
 * condition out (and stating outright that they are conscious) removes the
 * inference the model was getting wrong.
 */
export function describeCondition(hp: number, maxHp: number): string {
  if (hp <= 0) return 'DOWN -- at 0 HP, mortally wounded; this is the only state in which you may narrate collapse or death';
  const ratio = maxHp > 0 ? hp / maxHp : 1;
  const severity =
    ratio >= 1 ? 'unhurt' : ratio > 0.6 ? 'lightly hurt' : ratio > 0.3 ? 'wounded' : 'badly wounded';
  return `${severity} but CONSCIOUS, standing and able to act -- do NOT narrate collapse, blackout, or dying`;
}

export function formatHeroGroundTruth(state: GameState): string {
  const c = state.character;
  const items = c.inventory.length
    ? c.inventory.map((i) => `${i.name} x${i.qty}`).join(', ')
    : '(nothing)';
  return [
    `HP ${c.hp}/${c.maxHp} | AC ${c.ac} | gold ${c.gold} | XP ${c.xp} | luck ${c.luck} | level ${c.level}`,
    `Condition: ${describeCondition(c.hp, c.maxHp)}`,
    `Carrying: ${items}`,
    `Location: ${state.world.location}`,
  ].join('\n');
}

/**
 * Builds the narrator's one user message for this turn: scene context/the
 * player's cue (the incoming send() text, cleaned of referee-only noise, plus a
 * story-so-far hint when present) + the referee's beat sheet + the formatted
 * tool-outcome record + the ground-truth hero sheet above. Exported for direct
 * unit testing.
 */
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
[STAY INSIDE THE FACTS]
- Narrate ONLY the harm and gains listed above. If no damage was applied to the hero this turn, they take no new wound -- an enemy attack that missed leaves them untouched.
- Never escalate the hero's condition past the Condition line. Unless it says DOWN, they are conscious, on their feet, and can act next turn: no blacking out, no fading to silence, no "life slipping away".
- NO REWARD THAT IS NOT LISTED ABOVE. If no gold was awarded this turn, the hero finds no coin -- do not write a purse, a pouch, "a handful of silver", or any amount of money. If no item was added, they pick up nothing: no dagger, no map, no letter, no key. A searched body with nothing in the tool outcomes came up empty, and you say so. Naming loot the ledger does not have is the worst mistake you can make here, because the player's sidebar contradicts it instantly.
- OBEY EVERY ROLL LISTED ABOVE. A roll marked failure IS a failure: the attempt does not quietly succeed later in your paragraph. Never narrate both a success and a failure of the same attempt.

Write the narration now, in your voice, ending with "What do you do?" unless the Condition line says DOWN. Then, on one final line after the prose, add the machine-read suggestions trailer: [[SUGGEST: three | short | scene-specific actions]] (2-5 words each, phrased as the player would type them). Every suggestion must be something the hero can actually do right now -- never suggest using an item that is not in the Carrying list above. It is stripped before display and shown as buttons, so it must come last and must never appear inside your prose.`;
}

export interface DualModelDmSessionOptions {
  /** Test seam: forwarded to loadSettings() instead of the real process.cwd() settings.json -- see OpenAiDmSessionOptions for the identical rationale. */
  settingsBaseDir?: string;
  /** Test seam: overrides STREAM_STALL_TIMEOUT_MS so a test can prove the stall watchdog in milliseconds instead of ninety seconds. */
  stallTimeoutMs?: number;
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
  /** Sibling latch for the missing combat-consequence nudge -- same once-per-player-turn contract as retriedEmptyTurn. */
  private retriedMissingConsequence = false;

  private abortController?: AbortController;
  private runTurnPromise?: Promise<void>;
  private closed = false;
  private _busy = false;

  /** Set by the stall watchdog just before it aborts, so the abort handlers can tell a hung provider apart from the player pressing STOP and report the first while staying silent about the second. */
  private stalled = false;
  private stallTimer?: ReturnType<typeof setTimeout>;
  private stallPhase?: 'referee' | 'narrator';

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

  // -- Stall watchdog -------------------------------------------------------
  //
  // A live turn hung for over five minutes with no output and no way back
  // except the STOP button: a free-tier provider accepted the request, opened
  // the stream and then simply never sent a byte, leaving reader.read() awaiting
  // a chunk that was never coming. A total-duration cap would be the wrong
  // instrument -- turns on these models legitimately run two to three minutes
  // and complete fine -- so this watches for SILENCE instead: the clock resets
  // on every chunk that arrives, and only a genuinely dead stream trips it.
  //
  // Deliberately scoped to the network read alone (armed before the POST,
  // cleared the moment the stream ends). Tool execution happens outside that
  // window, which matters because an interactive player roll parks the turn
  // until the player physically clicks ROLL -- a wait that is not a stall and
  // must never be killed.

  private get stallTimeoutMs(): number {
    return this.opts?.stallTimeoutMs ?? STREAM_STALL_TIMEOUT_MS;
  }

  private startStallTimer(): void {
    this.stallTimer = setTimeout(() => {
      this.stalled = true;
      this.abortController?.abort();
    }, this.stallTimeoutMs);
  }

  private armStallWatchdog(phase: 'referee' | 'narrator'): void {
    this.clearStallWatchdog();
    this.stallPhase = phase;
    this.startStallTimer();
  }

  /** Called on every chunk off the wire: progress means the stream is alive, so start the silence clock over. */
  private touchStallWatchdog(): void {
    if (this.stallTimer === undefined) return;
    clearTimeout(this.stallTimer);
    this.startStallTimer();
  }

  private clearStallWatchdog(): void {
    if (this.stallTimer !== undefined) {
      clearTimeout(this.stallTimer);
      this.stallTimer = undefined;
    }
  }

  /**
   * Distinguishes the two ways a turn gets aborted. The player pressing STOP
   * stays silent (they know what they did); the watchdog firing must say so,
   * or the player is left staring at a turn that ended for no visible reason.
   */
  private reportStallIfAny(): void {
    if (!this.stalled) return;
    this.stalled = false;
    const phase = this.stallPhase ?? 'referee';
    this.callbacks.onError?.(
      new DmError(
        'unknown',
        `${phase} stream produced nothing for ${this.stallTimeoutMs}ms`,
        `The Dungeon Master (${phase}) went quiet mid-turn and stopped responding — the model or provider stalled. Nothing was lost; try that again.`,
      ),
    );
  }

  private async runTurn(): Promise<void> {
    try {
      if (this.closed) return;
      const referee = await this.runRefereePhase();
      if (!referee || this.closed) return; // error/abort already reported by the referee phase itself
      await this.runNarratorPhase(referee);
    } finally {
      this.clearStallWatchdog();
      this.stalled = false;
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
    this.retriedMissingConsequence = false;

    for (let step = 0; step < this.maxSteps; step++) {
      if (this.closed) return undefined;

      const abortController = new AbortController();
      this.abortController = abortController;

      this.armStallWatchdog('referee');

      let response: Response;
      try {
        response = await this.postRefereeCompletion(abortController.signal);
      } catch (err) {
        this.clearStallWatchdog();
        if (isAbortError(err)) {
          this.reportStallIfAny();
          return undefined;
        }
        this.callbacks.onError?.(classifyNetworkError(err));
        return undefined;
      }

      if (!response.ok) {
        this.clearStallWatchdog();
        const bodyText = await safeReadText(response);
        this.callbacks.onError?.(classifyHttpError(response.status, bodyText));
        return undefined;
      }
      if (!response.body) {
        this.clearStallWatchdog();
        this.callbacks.onError?.(
          new DmError('unknown', 'empty response body', 'The Dungeon Master (referee) returned an empty response.'),
        );
        return undefined;
      }

      let stepResult: StepResult;
      try {
        stepResult = await this.consumeStream(response.body, { forwardDeltas: false });
      } catch (err) {
        this.clearStallWatchdog();
        if (isAbortError(err)) {
          this.reportStallIfAny();
          return undefined;
        }
        this.callbacks.onError?.(classifyNetworkError(err));
        return undefined;
      }
      // Cleared before tool execution on purpose: an interactive player roll
      // parks the turn here until the player clicks, and that wait is not a stall.
      this.clearStallWatchdog();
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
        // Never push an empty assistant turn: a model can legitimately stop
        // with finish_reason:'stop' and no content, and several
        // OpenAI-compatible providers reject a message whose content is "" --
        // which would turn a recoverable skipped-tools turn into a hard 400.
        this.refereeMessages.push({
          role: 'assistant',
          content: stepResult.content.length > 0 ? stepResult.content : '(no beat sheet produced)',
        });
        this.refereeMessages.push({
          role: 'user',
          content:
            'You ended that turn without calling a single tool. Re-read the player\'s action: if ANYTHING mechanical happened — the hero drank/used/consumed an item, healed, rested, took damage, attacked, defeated a foe, took or paid gold, gained or lost an item, earned XP, or moved somewhere new — call the matching tools NOW (heal, apply_damage, defeat_foe, remove_item, add_item, award_gold, spend_gold, award_xp, set_location, roll_dice...). Gold the hero PICKS UP is award_gold; gold they PAY is spend_gold. The player\'s screen only ever shows what these tools record, so an unrecorded change simply did not happen. If the turn genuinely involved nothing mechanical, reply with your beat sheet again and call nothing.',
        });
        continue;
      }

      // The referee is willing to roll for a fight and then walk away from
      // its consequences: in a live turn it rolled the attack, wrote "the man
      // collapses, dead before he hits the ground", and called nothing else --
      // no XP, no NPC record. Telling it about defeat_foe in the prompt did not
      // fix that, so this checks the one thing the prompt cannot: the beat
      // sheet SAYS something went down, yet no defeat_foe landed. Same shape as
      // the zero-tool nudge above, and the referee is free to decline (it was
      // the hero who fell, or nobody actually died) by repeating its beat sheet.
      // An attack that CONNECTS must leave a mark somewhere: the hero's HP if
      // the blow was aimed at them, or a defeated foe if it was theirs. Neither
      // tool firing after a successful attack roll means the fight happened
      // only in prose -- which is exactly what a live turn did twice, once
      // letting a killed bandit pay no XP and once letting a landed enemy blow
      // ("the force of the blow jolting through your body") leave the HP bar
      // untouched at 7/12.
      const consequenceMissing = !outcomes.some((o) => (o.tool === 'defeat_foe' || o.tool === 'apply_damage') && o.ok);
      const combatHappened = this.beatSheetReportsFoeDown(beatSheet) || landedAnAttack(outcomes);
      if (!this.retriedMissingConsequence && consequenceMissing && combatHappened) {
        this.retriedMissingConsequence = true;
        // Server-side only: whether this nudge fires (and whether it works) is
        // otherwise invisible, and it is the one guardrail standing between a
        // won fight and 0 XP.
        console.error('[referee] an attack landed but nothing was recorded — nudging once');
        this.refereeMessages.push({
          role: 'assistant',
          content: stepResult.content.length > 0 ? stepResult.content : '(no beat sheet produced)',
        });
        this.refereeMessages.push({
          role: 'user',
          content:
            'An attack LANDED this turn and you are about to end the turn without recording what it did. A blow that connects must change something, or it did not happen at all as far as the player\'s screen is concerned. Right now, before you finish:\n' +
            '- Did an enemy hit the HERO? Call apply_damage NOW with the damage, this turn, not next turn. Their HP bar is the only injury the player can see; prose about a blow "jolting through your body" over an unchanged HP bar is a bug they will notice immediately.\n' +
            '- Did an enemy go down — killed, knocked out, driven off, surrendered? Call defeat_foe with their name and the XP (25-100 a thug or minor beast, 150-450 a real fight, 500+ a boss), plus award_gold / add_item for anything lootable you described. A foe you described dropping but never passed to defeat_foe is still alive as far as the game is concerned, and the fight paid nothing.\n' +
            'If the hero was genuinely untouched and the foe is genuinely still standing, that is fine — call nothing and reply with your beat sheet again.',
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

  /**
   * True when the beat sheet plainly reports something stopping fighting.
   *
   * Deliberately a blunt keyword test, and deliberately allowed to be wrong:
   * a false positive costs one extra referee request that the model answers by
   * repeating its beat sheet, while a false negative costs the player the XP
   * for a whole fight. Lines that are only about the HERO going down are
   * skipped, so a hero death does not get mistaken for a victory.
   */
  private beatSheetReportsFoeDown(beatSheet: string): boolean {
    if (!beatSheet) return false;
    const heroName = this.config.stateSnapshot?.()?.character.name;
    return beatSheet
      .split(/(?<=[.!?])\s+|\n+/)
      .filter((sentence) => {
        // "Bran takes 6 damage and falls" is not a victory. Only skip when the
        // sentence is about the hero and no separate foe is named as going down.
        const aboutHero = /\b(hero|player)\b/i.test(sentence) || (heroName ? sentence.includes(heroName) : false);
        return !aboutHero;
      })
      .some((sentence) => FOE_DOWN_RE.test(sentence));
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

    let narration = '';

    for (let attempt = 0; ; attempt++) {
      const abortController = new AbortController();
      this.abortController = abortController;
      this.armStallWatchdog('narrator');

      let response: Response;
      try {
        response = await this.postNarratorCompletion(requestMessages, abortController.signal);
      } catch (err) {
        this.clearStallWatchdog();
        if (isAbortError(err)) {
          this.reportStallIfAny();
          return;
        }
        this.callbacks.onError?.(classifyNetworkError(err));
        return;
      }

      if (!response.ok) {
        this.clearStallWatchdog();
        const bodyText = await safeReadText(response);
        this.callbacks.onError?.(classifyHttpError(response.status, bodyText));
        return;
      }
      if (!response.body) {
        this.clearStallWatchdog();
        this.callbacks.onError?.(
          new DmError('unknown', 'empty response body', 'The Dungeon Master (narrator) returned an empty response.'),
        );
        return;
      }

      let stepResult: StepResult;
      try {
        stepResult = await this.consumeStream(response.body, { forwardDeltas: true });
      } catch (err) {
        this.clearStallWatchdog();
        if (isAbortError(err)) {
          this.reportStallIfAny();
          return;
        }
        this.callbacks.onError?.(classifyNetworkError(err));
        return;
      }
      this.clearStallWatchdog();
      this.abortController = undefined;

      // An empty narration is a dead turn for the player, so ask once more
      // before giving up -- the referee's work is already committed and would
      // otherwise be dramatised by nobody.
      if (stepResult.content.length === 0) {
        if (attempt < NARRATOR_EMPTY_RETRIES && !this.closed) {
          this.callbacks.onSystemNote?.('(the narrator returned nothing — asking again)');
          continue;
        }
        this.callbacks.onError?.(
          new DmError('unknown', 'stream ended with no content', 'The Dungeon Master (narrator) returned nothing — please try again.'),
        );
        return;
      }

      narration = stepResult.content;
      break;
    }

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
        this.touchStallWatchdog(); // bytes arrived -- the stream is alive, restart the silence clock

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
