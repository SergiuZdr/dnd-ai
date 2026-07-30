// Owner-run live smoke test for the OpenAI-compatible DM backend (P1). Mirror
// of scripts/smoke/smoke.ts, but against OpenAiDmSession + a REAL OpenAI-compatible
// endpoint (Ollama / OpenRouter / self-host) instead of the Claude Agent SDK
// -- proves tool-calling, streaming, and the interactive-roll pause all work
// end-to-end against whatever the owner configured in settings.json's
// `openai` block (baseUrl/model/apiKeyEnv). NOT part of `npm test` -- it
// makes real network calls and its quality depends entirely on which model
// the owner pointed it at (per the PRD's spike, a 3B local model is too weak;
// use something more capable).
//
// Usage: npm run smoke:openai
// Quick overrides without editing settings.json:
//   DND_OPENAI_BASE_URL=http://127.0.0.1:11434/v1 DND_OPENAI_MODEL=llama3.1:70b npm run smoke:openai

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Engine } from '../../src/game/engine';
import type { EngineResult } from '../../src/game/engine';
import type { GameState } from '../../src/game/state';
import { saveGame, loadGame } from '../../src/game/saves';
import { createDmTools } from '../../src/ai/tools';
import { dmSystemPrompt, buildOpeningPrompt, withMechanicsReminder } from '../../src/ai/prompts';
import { OpenAiDmSession } from '../../src/ai/openaiDm';
import type { DmError } from '../../src/ai/dm';
import { loadSettings } from '../../src/game/settings';

const OVERALL_TIMEOUT_MS = 300_000;

function buildFixtureState(): GameState {
  const ts = new Date().toISOString();
  return {
    campaign: {
      slug: 'openai-smoke-test',
      name: 'OpenAI Smoke Test',
      createdAt: ts,
      updatedAt: ts,
      contentRating: 'PG-13',
    },
    character: {
      name: 'Theron',
      className: 'Fighter',
      race: 'Human',
      background: 'Soldier',
      backgroundFact: 'served as a soldier before taking up adventuring, and still carries an old service blade from that time',
      level: 1,
      xp: 0,
      hp: 12,
      maxHp: 12,
      ac: 14,
      stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 8 },
      gold: 10,
      inventory: [{ name: 'Dagger', qty: 1 }],
      luck: 1,
    },
    world: {
      theme: 'classic fantasy',
      location: 'Unknown',
      npcs: [],
      quests: [],
      facts: [],
    },
    chronicle: {
      storySoFar: '',
      chapters: [],
      lastSummarizedIndex: 0,
    },
  };
}

interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

async function main(): Promise<void> {
  const { settings } = loadSettings();
  const baseUrl = process.env.DND_OPENAI_BASE_URL ?? settings.openai.baseUrl;
  const model = process.env.DND_OPENAI_MODEL ?? settings.openai.model;
  const apiKeyEnv = process.env.DND_OPENAI_API_KEY_ENV ?? settings.openai.apiKeyEnv;

  console.error(`[openai-smoke] backend config: baseUrl=${baseUrl} model=${model} apiKeyEnv=${apiKeyEnv ?? '(none)'}`);
  if (settings.dmBackend !== 'openai') {
    console.error(
      `[openai-smoke] note: settings.json's dmBackend is "${settings.dmBackend}", not "openai" -- that only affects the real game (this script always drives OpenAiDmSession directly). Set dmBackend:"openai" to make actual gameplay use this endpoint.`,
    );
  }

  const state = buildFixtureState(); // mutated in place by the engine

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-ai-openai-smoke-'));
  console.error(`[openai-smoke] saves dir: ${tmpDir}`);

  let mutationCount = 0;
  const engine = new Engine(state);
  engine.onMutation = () => {
    saveGame(state, tmpDir);
    mutationCount += 1;
  };

  const toolCallCounts: Record<string, number> = {};
  let playerRollRequests = 0;
  const { server, allowedTools, tools } = createDmTools(engine, {
    onToolResult: (toolName: string, result: EngineResult) => {
      toolCallCounts[toolName] = (toolCallCounts[toolName] ?? 0) + 1;
      if (result.ok) {
        console.error(`[tool] ${toolName} -> OK: ${result.message}`);
      } else {
        console.error(`[tool] ${toolName} -> ERROR: ${result.error}`);
      }
    },
    interactiveRoll: async (request) => {
      playerRollRequests += 1;
      console.error(
        `[interactive_roll] roller=player expr=${request.expr} dc=${request.dc ?? 'none'} reason=${request.reason}`,
      );
      return engine.rollDice(request.expr, request.mode, request.reason, request.dc);
    },
  });

  const completedTurns: Array<{ text: string }> = [];
  let turnWaiter: (() => void) | undefined;
  let lastError: DmError | undefined;

  function waitForNextTurn(): Promise<void> {
    return new Promise((resolve) => {
      turnWaiter = resolve;
    });
  }

  function resolveWaiter(): void {
    const w = turnWaiter;
    turnWaiter = undefined;
    w?.();
  }

  const session = new OpenAiDmSession(
    {
      systemPrompt: dmSystemPrompt('PG-13'),
      server,
      allowedTools,
      tools,
      maxTurnsPerMessage: 12,
      ...(process.env.DND_OPENAI_MODEL ? { model: process.env.DND_OPENAI_MODEL } : {}),
    },
    {
      onDelta: (text: string) => {
        process.stdout.write(text);
      },
      onToolUse: (toolName: string) => {
        console.error(`[tool_use] ${toolName}`);
      },
      onTurnComplete: ({ text }) => {
        completedTurns.push({ text });
        console.error(`\n[turn_complete] #${completedTurns.length} chars=${text.length}`);
        resolveWaiter();
      },
      onSystemNote: (note: string) => {
        console.error(`[system_note] ${note}`);
      },
      onError: (err: DmError) => {
        lastError = err;
        console.error(`[dm_error] kind=${err.kind} message=${err.message}`);
        console.error(`[dm_error] friendly=${err.friendly}`);
        resolveWaiter();
      },
    },
  );

  let aborted = false;

  async function sendAndWait(text: string, label: string): Promise<void> {
    if (aborted) return;
    console.error(`\n[openai-smoke] sending ${label}...`);
    const wait = waitForNextTurn();
    session.send(text);
    await wait;
    if (lastError) {
      console.error(`[openai-smoke] DM error surfaced during "${label}" -- aborting remaining turns.`);
      aborted = true;
    }
  }

  session.start();

  await sendAndWait(buildOpeningPrompt(state), 'opening prompt');
  await sendAndWait(
    withMechanicsReminder('I throw my shoulder against the locked door and try to force it open.', state),
    'force-door prompt',
  );
  await sendAndWait(
    withMechanicsReminder('I search the room and grab anything valuable I can carry.', state),
    'loot prompt',
  );

  await session.end();

  // --- Tool-calling score (4 checks, target >= 3/4 per the PRD) ---
  const checks: CheckResult[] = [];

  const allTurnsNarrated = completedTurns.length === 3 && completedTurns.every((t) => t.text.length > 40);
  checks.push({
    name: 'every_turn_produced_narration_gt_40_chars',
    pass: allTurnsNarrated,
    detail: `turns=${completedTurns.length} lengths=[${completedTurns.map((t) => t.text.length).join(',')}]`,
  });

  const rollDiceCalls = toolCallCounts.roll_dice ?? 0;
  checks.push({ name: 'roll_dice_called_at_least_once', pass: rollDiceCalls >= 1, detail: `count=${rollDiceCalls}` });

  checks.push({
    name: 'player_roll_requested_at_least_once',
    pass: playerRollRequests >= 1,
    detail: `count=${playerRollRequests}`,
  });

  const mutatingToolCalls = Object.entries(toolCallCounts)
    .filter(([name]) => name !== 'roll_dice')
    .reduce((sum, [, count]) => sum + count, 0);
  checks.push({
    name: 'state_mutating_tool_called_at_least_once',
    pass: mutatingToolCalls >= 1,
    detail: `count=${mutatingToolCalls}`,
  });

  console.error('');
  for (const check of checks) {
    const suffix = check.detail ? ` (${check.detail})` : '';
    console.error(`[check] ${check.name}: ${check.pass ? 'PASS' : 'FAIL'}${suffix}`);
  }

  const score = checks.filter((c) => c.pass).length;
  console.error('');
  console.error(`[summary] tool call counts: ${JSON.stringify(toolCallCounts)}`);
  console.error(`[summary] mutation count: ${mutationCount}`);
  console.error(`\nTOOL-CALLING SCORE: ${score}/${checks.length}`);

  let saveDetail = '';
  try {
    const reloaded = loadGame('openai-smoke-test', tmpDir);
    saveDetail = JSON.stringify(reloaded) === JSON.stringify(state) ? 'save round-trip OK' : 'save round-trip MISMATCH';
  } catch (err) {
    saveDetail = err instanceof Error ? err.message : String(err);
  }
  console.error(`[summary] ${saveDetail}`);

  if (score >= 3) {
    console.error('\nSMOKE RESULT: PASS');
    process.exit(0);
  } else {
    console.error(`\nSMOKE RESULT: FAIL (score ${score}/${checks.length}, need >= 3/4)`);
    process.exit(1);
  }
}

const timeout = setTimeout(() => {
  console.error('SMOKE RESULT: TIMEOUT');
  process.exit(2);
}, OVERALL_TIMEOUT_MS);

main()
  .catch((err) => {
    console.error('[fatal error]', err);
    process.exit(1);
  })
  .finally(() => {
    clearTimeout(timeout);
  });
