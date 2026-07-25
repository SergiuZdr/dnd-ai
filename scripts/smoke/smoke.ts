// Step 2 smoke test: headless end-to-end proof that the AI layer works
// against the real Agent SDK. Real billed turns (~3) are intended here — this
// is the thing that proves tool calls, streaming, and persistence all click
// together before any UI is built on top.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Engine } from '../../src/game/engine';
import type { EngineResult } from '../../src/game/engine';
import type { GameState } from '../../src/game/state';
import { saveGame, loadGame } from '../../src/game/saves';
import { createDmTools } from '../../src/ai/tools';
import { dmSystemPrompt, buildOpeningPrompt, withMechanicsReminder } from '../../src/ai/prompts';
import { DmSession } from '../../src/ai/dm';
import type { DmError } from '../../src/ai/dm';

const OVERALL_TIMEOUT_MS = 300_000;

function buildFixtureState(): GameState {
  const ts = new Date().toISOString();
  return {
    campaign: {
      slug: 'smoke-test',
      name: 'Smoke Test',
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
  const fixture = buildFixtureState(); // pristine, never mutated — the "before" snapshot
  const state = buildFixtureState(); // mutated in place by the engine

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-ai-smoke-'));
  console.error(`[smoke] saves dir: ${tmpDir}`);

  let mutationCount = 0;
  const engine = new Engine(state);
  engine.onMutation = () => {
    saveGame(state, tmpDir);
    mutationCount += 1;
  };

  const toolCallCounts: Record<string, number> = {};
  // Counts roll_dice calls that arrived with roller:'player' — the trigger the
  // real game's interactive roll button hangs off. The hook resolves rolls
  // instantly (no UI here), but its mere invocation proves the DM model emits
  // roller:'player' for hero actions, not just bare roll_dice calls.
  let playerRollRequests = 0;
  const { server, allowedTools } = createDmTools(engine, {
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

  const completedTurns: Array<{ text: string; costUsd?: number }> = [];
  let totalCostUsd = 0;
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

  const session = new DmSession(
    {
      systemPrompt: dmSystemPrompt('PG-13'),
      server,
      allowedTools,
      maxTurnsPerMessage: 12,
    },
    {
      onDelta: (text: string) => {
        process.stdout.write(text);
      },
      onToolUse: (toolName: string) => {
        console.error(`[tool_use] ${toolName}`);
      },
      onTurnComplete: ({ text, costUsd }) => {
        completedTurns.push({ text, costUsd });
        if (typeof costUsd === 'number') totalCostUsd += costUsd;
        console.error(
          `\n[turn_complete] #${completedTurns.length} chars=${text.length} costUsd=${costUsd ?? 'n/a'}`,
        );
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
    console.error(`\n[smoke] sending ${label}...`);
    const wait = waitForNextTurn();
    session.send(text);
    await wait;
    if (lastError) {
      console.error(`[smoke] DM error surfaced during "${label}" — aborting remaining turns.`);
      aborted = true;
    }
  }

  session.start();

  // Player actions go through withMechanicsReminder so this smoke exercises
  // the exact wire format the controller sends in the real game (the opening
  // prompt is sent bare there too).
  await sendAndWait(buildOpeningPrompt(state), 'opening prompt');
  // Both actions are deliberately scene-independent attempts-that-could-fail
  // (stealth+climb, then persuasion) so a rules-honoring DM must roll no
  // matter what opening scene it invented -- "attack the nearest enemy" style
  // prompts made this check flaky, fizzling roll-free whenever the random
  // opening happened to be peaceful.
  await sendAndWait(
    withMechanicsReminder(
      'I slip away and try to quietly climb to a high vantage point — a wall, roof, or tall tree — to survey the area without being noticed.',
      state,
    ),
    'stealth-climb prompt',
  );
  await sendAndWait(
    withMechanicsReminder(
      'I approach the nearest person and try to charm out of them a secret or rumor they would not normally tell a stranger.',
      state,
    ),
    'persuasion prompt',
  );

  await session.end();

  // --- Final checks ---
  const checks: CheckResult[] = [];

  const allTurnsNarrated =
    completedTurns.length === 3 && completedTurns.every((t) => t.text.length > 40);
  checks.push({
    name: 'every_turn_produced_narration_gt_40_chars',
    pass: allTurnsNarrated,
    detail: `turns=${completedTurns.length} lengths=[${completedTurns.map((t) => t.text.length).join(',')}]`,
  });

  const rollDiceCalls = toolCallCounts.roll_dice ?? 0;
  checks.push({
    name: 'roll_dice_called_at_least_once',
    pass: rollDiceCalls >= 1,
    detail: `count=${rollDiceCalls}`,
  });

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

  const inventoryChanged =
    JSON.stringify(state.character.inventory) !== JSON.stringify(fixture.character.inventory);
  const stateChanged =
    state.world.location !== fixture.world.location ||
    state.world.npcs.length > 0 ||
    state.character.gold !== fixture.character.gold ||
    inventoryChanged ||
    state.character.hp !== fixture.character.hp ||
    state.world.facts.length > 0;
  checks.push({
    name: 'state_changed_vs_fixture',
    pass: stateChanged,
    detail:
      `location=${state.world.location} npcs=${state.world.npcs.length} gold=${state.character.gold} ` +
      `inventoryChanged=${inventoryChanged} hp=${state.character.hp} facts=${state.world.facts.length}`,
  });

  let saveRoundTrip = false;
  let saveDetail = '';
  try {
    const savedFiles = fs.readdirSync(path.join(tmpDir, 'smoke-test')).sort();
    const reloaded = loadGame('smoke-test', tmpDir);
    saveRoundTrip = JSON.stringify(reloaded) === JSON.stringify(state);
    saveDetail = `files=[${savedFiles.join(',')}] mutations=${mutationCount}`;
  } catch (err) {
    saveDetail = err instanceof Error ? err.message : String(err);
  }
  checks.push({ name: 'save_files_exist_and_roundtrip', pass: saveRoundTrip, detail: saveDetail });

  // Note: transcript persistence (appendTranscript/readTranscript) is out of
  // scope for this smoke test — the controller wires that up later.

  console.error('');
  for (const check of checks) {
    const suffix = check.detail ? ` (${check.detail})` : '';
    console.error(`[check] ${check.name}: ${check.pass ? 'PASS' : 'FAIL'}${suffix}`);
  }

  console.error('');
  console.error(`[summary] tool call counts: ${JSON.stringify(toolCallCounts)}`);
  console.error(`[summary] total cost usd: ${totalCostUsd}`);
  console.error(`[summary] mutation count: ${mutationCount}`);

  const allPass = checks.every((c) => c.pass);
  if (allPass) {
    console.error('\nSMOKE RESULT: PASS');
    process.exit(0);
  } else {
    const failedNames = checks.filter((c) => !c.pass).map((c) => c.name);
    console.error(`\nSMOKE RESULT: FAIL (${failedNames.join(', ')})`);
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
