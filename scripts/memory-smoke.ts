// Step 4 smoke test: headless, real-SDK proof that the "forever" memory
// system works end-to-end -- summarizer, chronicle persistence, and quiet
// session rotation -- driven entirely through GameController's public API
// (start / submitPlayerAction / shutdown), the same surface the TUI uses.
// Real billed turns are intended here: ~4 DM turns + at least one haiku
// summarizer call + a resume turn (~6-7 total).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GameState } from '../src/game/state';
import { loadGame } from '../src/game/saves';
import { GameController } from '../src/game/controller';
import type { ControllerCallbacks, DmSessionLike } from '../src/game/controller';
import { DmSession } from '../src/ai/dm';
import type { DmSessionCallbacks, DmSessionConfig } from '../src/ai/dm';
import { summarizeChunk } from '../src/ai/summarizer';

const OVERALL_TIMEOUT_MS = 420_000;
const CHRONICLE_NOTE_TIMEOUT_MS = 120_000;
const CHRONICLE_UPDATED_NOTE = '✦ Chronicle updated — the tale is preserved.';

function buildFixtureState(): GameState {
  const ts = new Date().toISOString();
  return {
    campaign: {
      slug: 'memory-smoke',
      name: 'Memory Smoke Test',
      createdAt: ts,
      updatedAt: ts,
      contentRating: 'PG-13',
    },
    character: {
      name: 'Sable',
      className: 'Ranger',
      race: 'Half-Elf',
      background: 'Wanderer',
      backgroundFact: 'has wandered many roads before this one and rarely stays anywhere for long',
      level: 1,
      xp: 0,
      hp: 11,
      maxHp: 11,
      ac: 13,
      stats: { str: 12, dex: 16, con: 12, int: 10, wis: 14, cha: 10 },
      gold: 15,
      inventory: [{ name: 'Shortbow', qty: 1 }],
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

/** Wraps a real DmSession so the smoke script can inspect exactly what text was sent to it. */
class RecordingSession implements DmSessionLike {
  sentMessages: string[] = [];
  constructor(private readonly inner: DmSession) {}

  get busy(): boolean {
    return this.inner.busy;
  }

  start(): void {
    this.inner.start();
  }

  send(text: string): void {
    this.sentMessages.push(text);
    this.inner.send(text);
  }

  interrupt(): Promise<void> {
    return this.inner.interrupt();
  }

  end(): Promise<void> {
    return this.inner.end();
  }
}

interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

/** Fatal DM-side errors we should abort on, matching DmError's friendly-message classification. */
function isFatalNote(note: string): boolean {
  return /not logged in|weave is exhausted/i.test(note);
}

async function main(): Promise<void> {
  const state = buildFixtureState();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-ai-memory-smoke-'));
  console.error(`[memory-smoke] saves dir: ${tmpDir}`);

  const checks: CheckResult[] = [];

  // -- Wave 1: fresh campaign, driven through GameController's public API --
  const sessions: RecordingSession[] = [];
  function sessionFactory(config: DmSessionConfig, callbacks: DmSessionCallbacks): DmSessionLike {
    const session = new RecordingSession(new DmSession(config, callbacks));
    sessions.push(session);
    console.error(`[memory-smoke] sessionFactory invoked (session #${sessions.length})`);
    return session;
  }

  const systemNotes: string[] = [];
  const noteListeners: Array<(note: string) => void> = [];
  function recordNote(note: string): void {
    systemNotes.push(note);
    console.error(`[system_note] ${note}`);
    for (const listener of [...noteListeners]) listener(note);
  }
  function waitForNote(predicate: (note: string) => boolean, timeoutMs: number, label: string): Promise<string> {
    const already = systemNotes.find(predicate);
    if (already !== undefined) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = noteListeners.indexOf(listener);
        if (idx !== -1) noteListeners.splice(idx, 1);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`));
      }, timeoutMs);
      const listener = (note: string): void => {
        if (!predicate(note)) return;
        clearTimeout(timer);
        const idx = noteListeners.indexOf(listener);
        if (idx !== -1) noteListeners.splice(idx, 1);
        resolve(note);
      };
      noteListeners.push(listener);
    });
  }

  let fatalError: string | undefined;
  let turnWaiter: (() => void) | undefined;
  function waitForNextIdle(): Promise<void> {
    return new Promise((resolve) => {
      turnWaiter = resolve;
    });
  }
  function resolveIdleWaiter(): void {
    const w = turnWaiter;
    turnWaiter = undefined;
    w?.();
  }

  let lastDmNarration = '';

  const cb: ControllerCallbacks = {
    onStoryAppend: (entry) => {
      if (entry.kind === 'dm') lastDmNarration = entry.text;
      const preview = entry.text.length > 120 ? `${entry.text.slice(0, 120)}…` : entry.text;
      console.error(`[story:${entry.kind}] ${preview}`);
    },
    onStreamText: (partial) => {
      if (partial.length > 0) process.stderr.write('.');
    },
    onStateChange: () => {},
    onDiceRoll: (message) => console.error(`[dice] ${message}`),
    onToolActivity: (toolName) => console.error(`[tool_use] ${toolName}`),
    onBusyChange: (busy) => {
      if (!busy) resolveIdleWaiter();
    },
    onSystemNote: (note) => {
      recordNote(note);
      if (isFatalNote(note)) fatalError = note;
    },
    onRollPrompt: () => {},
  };

  const controller = new GameController(state, cb, {
    baseDir: tmpDir,
    summarizeThresholdEntries: 4,
    summarizeThresholdChars: 2000,
    sessionFactory,
    summarizeFn: summarizeChunk,
  });

  async function driveAndWait(label: string, action: () => void): Promise<void> {
    console.error(`\n[memory-smoke] ${label}...`);
    const idle = waitForNextIdle();
    action();
    await idle;
    console.error('');
    if (fatalError) {
      throw new Error(`Fatal DM error during "${label}": ${fatalError}`);
    }
  }

  await driveAndWait("start('new')", () => controller.start('new'));
  await driveAndWait('action 1: ask about work', () =>
    controller.submitPlayerAction('I ask the nearest person about work.'),
  );
  await driveAndWait('action 2: accept and set out', () =>
    controller.submitPlayerAction('I accept and set out at once.'),
  );
  await driveAndWait('action 3: press on and make camp', () =>
    controller.submitPlayerAction('I press on and make camp for the night.'),
  );

  console.error(`\n[memory-smoke] waiting up to ${CHRONICLE_NOTE_TIMEOUT_MS}ms for the chronicle-updated note...`);
  await waitForNote((n) => n === CHRONICLE_UPDATED_NOTE, CHRONICLE_NOTE_TIMEOUT_MS, 'chronicle updated note');

  checks.push({
    name: 'chronicle_has_at_least_one_chapter',
    pass: state.chronicle.chapters.length >= 1,
    detail: `chapters=${state.chronicle.chapters.length}`,
  });
  checks.push({
    name: 'story_so_far_rollup_over_50_chars',
    pass: state.chronicle.storySoFar.length > 50,
    detail: `len=${state.chronicle.storySoFar.length} text="${state.chronicle.storySoFar.slice(0, 80)}…"`,
  });
  checks.push({
    name: 'session_factory_invoked_at_least_twice',
    pass: sessions.length >= 2,
    detail: `count=${sessions.length}`,
  });

  await driveAndWait('post-rotation action: recall purpose', () =>
    controller.submitPlayerAction('I recall my purpose and continue onward.'),
  );

  checks.push({
    name: 'post_rotation_narration_gt_40_chars',
    pass: lastDmNarration.length > 40,
    detail: `len=${lastDmNarration.length}`,
  });

  // The rotated session's first send should have carried the held pendingBrief --
  // exercised by the post-rotation action just driven above.
  const rotatedSessionSend = sessions.length >= 2 ? sessions[1].sentMessages[0] : undefined;
  if (rotatedSessionSend !== undefined) {
    const briefWasPrepended =
      rotatedSessionSend.startsWith('[CAMPAIGN BRIEFING') && rotatedSessionSend.includes('[The player now acts:]');
    console.error(
      `[info] rotated session's first send carried the pendingBrief: ${briefWasPrepended ? 'YES' : 'NO'}`,
    );
  } else {
    console.error('[info] rotated session had no recorded send to inspect (unexpected).');
  }

  await controller.shutdown();

  // -- Relaunch simulation: fresh process, fresh controller, resume from disk --
  const reloadedState = loadGame('memory-smoke', tmpDir);
  console.error(
    `\n[memory-smoke] reloaded state -- location="${reloadedState.world.location}" chapters=${reloadedState.chronicle.chapters.length}`,
  );

  const resumeSessions: RecordingSession[] = [];
  function resumeSessionFactory(config: DmSessionConfig, callbacks: DmSessionCallbacks): DmSessionLike {
    const session = new RecordingSession(new DmSession(config, callbacks));
    resumeSessions.push(session);
    return session;
  }

  let resumeFatalError: string | undefined;
  let resumeTurnWaiter: (() => void) | undefined;
  function waitForNextResumeIdle(): Promise<void> {
    return new Promise((resolve) => {
      resumeTurnWaiter = resolve;
    });
  }

  let resumeNarration = '';
  const cb2: ControllerCallbacks = {
    onStoryAppend: (entry) => {
      if (entry.kind === 'dm') resumeNarration = entry.text;
      const preview = entry.text.length > 120 ? `${entry.text.slice(0, 120)}…` : entry.text;
      console.error(`[resume story:${entry.kind}] ${preview}`);
    },
    onStreamText: (partial) => {
      if (partial.length > 0) process.stderr.write('.');
    },
    onStateChange: () => {},
    onDiceRoll: (message) => console.error(`[resume dice] ${message}`),
    onToolActivity: (toolName) => console.error(`[resume tool_use] ${toolName}`),
    onBusyChange: (busy) => {
      if (!busy) {
        const w = resumeTurnWaiter;
        resumeTurnWaiter = undefined;
        w?.();
      }
    },
    onSystemNote: (note) => {
      console.error(`[resume system_note] ${note}`);
      if (isFatalNote(note)) resumeFatalError = note;
    },
    onRollPrompt: () => {},
  };

  const controller2 = new GameController(reloadedState, cb2, {
    baseDir: tmpDir,
    summarizeThresholdEntries: 4,
    summarizeThresholdChars: 2000,
    sessionFactory: resumeSessionFactory,
    summarizeFn: summarizeChunk,
  });

  console.error("\n[memory-smoke] relaunch: start('resume')...");
  const resumeIdle = waitForNextResumeIdle();
  controller2.start('resume');
  await resumeIdle;
  console.error('');
  if (resumeFatalError) {
    throw new Error(`Fatal DM error during resume: ${resumeFatalError}`);
  }

  checks.push({
    name: 'resume_narration_gt_40_chars',
    pass: resumeNarration.length > 40,
    detail: `len=${resumeNarration.length}`,
  });

  const savedLocation = reloadedState.world.location;
  const mentionsLocation =
    savedLocation.length > 0 && savedLocation !== 'Unknown' && resumeNarration.toLowerCase().includes(savedLocation.toLowerCase());
  console.error(
    `[soft-check] resume narration mentions saved location "${savedLocation}": ${mentionsLocation ? 'YES' : 'NO (non-fatal)'}`,
  );

  await controller2.shutdown();

  console.error('');
  for (const check of checks) {
    const suffix = check.detail ? ` (${check.detail})` : '';
    console.error(`[check] ${check.name}: ${check.pass ? 'PASS' : 'FAIL'}${suffix}`);
  }

  const allPass = checks.every((c) => c.pass);
  if (allPass) {
    console.error('\nMEMORY SMOKE RESULT: PASS');
    process.exit(0);
  } else {
    const failedNames = checks.filter((c) => !c.pass).map((c) => c.name);
    console.error(`\nMEMORY SMOKE RESULT: FAIL (${failedNames.join(', ')})`);
    process.exit(1);
  }
}

const timeout = setTimeout(() => {
  console.error('MEMORY SMOKE RESULT: TIMEOUT');
  process.exit(2);
}, OVERALL_TIMEOUT_MS);

main()
  .catch((err) => {
    console.error('[fatal error]', err);
    console.error('\nMEMORY SMOKE RESULT: FAIL (fatal error)');
    process.exit(1);
  })
  .finally(() => {
    clearTimeout(timeout);
  });
