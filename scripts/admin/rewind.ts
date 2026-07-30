// Rewinds a campaign's STORY by N player turns, by truncating transcript.jsonl.
//
// READ THIS BEFORE USING IT -- what this can and cannot do:
//
//   transcript.jsonl is the only file in a save that holds HISTORY. character
//   .json and world.json are CURRENT-STATE SNAPSHOTS with no past: nothing in
//   a save records what your HP, gold, inventory or quests were N turns ago.
//   So this script rewinds what the DM remembers and what you see in the
//   story log; it CANNOT restore mechanical state you have since changed.
//
//   In practice that is usually fine, because it is exactly the turns where
//   the engine did NOT mutate that you want to take back. Run with no flags
//   first: the dry run prints every turn it would drop so you can read them
//   and decide.
//
//   It cannot decide FOR you, and an earlier version of this script wrongly
//   claimed it could -- see the note above the caution block in main().
//
// Chronicle safety: the DM's long-term memory (chronicle.json) summarises
// everything up to lastSummarizedIndex, and controller.ts replays only
// transcript.slice(lastSummarizedIndex) on resume. Truncating BELOW that index
// would leave chapters describing events no longer in the transcript, so this
// script refuses to cut past it unless you pass --force.
//
// Usage (dry run writes nothing):
//   npx tsx scripts/admin/rewind.ts --slug "1st and best world" --turns 5
//   npx tsx scripts/admin/rewind.ts --slug "1st and best world" --turns 5 --apply
//   npx tsx scripts/admin/rewind.ts --slug X --turns 5 --apply --saves-dir /opt/dnd/saves
//
// --saves-dir must be the directory the campaign folder sits DIRECTLY inside.
// Once players are registered, campaigns move under players/<id>/ (see
// scripts/admin/players.ts), so point it there:
//   --saves-dir /opt/dnd/saves/players/sergiu
//
// Stop the server before running with --apply: a live GameController holds the
// campaign in memory and will overwrite your edit on its next autosave.

import * as fs from 'node:fs';
import * as path from 'node:path';

interface TranscriptEntry {
  role: 'player' | 'dm' | 'system';
  text: string;
  ts: string;
}

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  return {
    slug: get('--slug'),
    turns: Number(get('--turns') ?? 5),
    savesDir: get('--saves-dir') ?? path.join(process.cwd(), 'saves'),
    apply: argv.includes('--apply'),
    force: argv.includes('--force'),
  };
}

/**
 * Finds the transcript index to truncate to, so that the last `turns` PLAYER
 * entries (and everything after each) are dropped. Returns 0 if there are
 * fewer than `turns` player entries. Pure -- exported for testing.
 */
export function cutIndexForTurns(entries: TranscriptEntry[], turns: number): number {
  const playerIdx: number[] = [];
  entries.forEach((e, i) => {
    if (e.role === 'player') playerIdx.push(i);
  });
  if (playerIdx.length <= turns) return 0;
  return playerIdx[playerIdx.length - turns];
}

function backup(file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.${stamp}.bak`;
  fs.copyFileSync(file, dest);
  return dest;
}

function main(): void {
  const { slug, turns, savesDir, apply, force } = parseArgs(process.argv.slice(2));

  if (!slug) {
    console.error('Usage: npx tsx scripts/admin/rewind.ts --slug "<campaign>" --turns 5 [--apply] [--saves-dir <path>]');
    process.exit(1);
  }
  if (!Number.isInteger(turns) || turns < 1) {
    console.error(`--turns must be a positive integer (got ${turns}).`);
    process.exit(1);
  }

  const dir = path.join(savesDir, slug);
  const file = path.join(dir, 'transcript.jsonl');
  if (!fs.existsSync(file)) {
    console.error(`No transcript at ${file}`);
    process.exit(1);
  }

  const entries: TranscriptEntry[] = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const cut = cutIndexForTurns(entries, turns);
  const dropped = entries.slice(cut);
  const playersDropped = dropped.filter((e) => e.role === 'player').length;

  if (dropped.length === 0) {
    console.log('Nothing to rewind.');
    return;
  }

  // Chronicle guard.
  const chroniclePath = path.join(dir, 'chronicle.json');
  let lastSummarized = 0;
  if (fs.existsSync(chroniclePath)) {
    const raw = JSON.parse(fs.readFileSync(chroniclePath, 'utf8'));
    lastSummarized = (raw?.data ?? raw)?.lastSummarizedIndex ?? 0;
  }

  console.log(`Campaign : ${slug}`);
  console.log(`Transcript: ${entries.length} entries -> ${cut} (dropping ${dropped.length}, ${playersDropped} player turn(s))`);
  console.log(`Chronicle : summarised up to index ${lastSummarized}\n`);

  if (cut < lastSummarized && !force) {
    console.error(
      `REFUSING: cutting to ${cut} would drop transcript the chronicle has already summarised (index ${lastSummarized}).\n` +
        `The DM's long-term memory would then describe events no longer in the log. Re-run with --force only if you\n` +
        `also intend to hand-edit chronicle.json.`,
    );
    process.exit(1);
  }

  console.log('These turns will be removed from the story:');
  for (const e of dropped) {
    const label = e.role === 'player' ? '  YOU' : e.role === 'dm' ? '   DM' : '  SYS';
    console.log(`${label}: ${e.text.replace(/\s+/g, ' ').slice(0, 110)}`);
  }

  // This USED to claim it could tell you whether the rewind was faithful or
  // lossy, by treating `system` transcript entries as engine roll/ledger
  // records. They are nothing of the kind: controller.ts only ever appends
  // 'player' (submitPlayerAction) and 'dm' (handleTurnComplete) entries, and
  // the sole `system` entry the game writes anywhere is the "A new hero rises"
  // note on retire. Engine results reach the UI via callbacks and never land in
  // transcript.jsonl at all. So the old check found nothing every single time
  // and printed a confident "FAITHFUL: nothing else needs editing" immediately
  // before an irreversible truncation -- worse than saying nothing.
  //
  // A save has no per-turn state history to compare against, so this genuinely
  // cannot be determined here. Say so plainly instead of inventing a signal.
  console.log('');
  console.log(
    'CAUTION: this truncates the STORY only. character.json / world.json are current-state\n' +
      'snapshots with no history, and nothing in a save records what your HP, gold, inventory or\n' +
      'quests were at the point you are cutting back to -- so any damage, loot, gold, XP, level-up\n' +
      'or quest change from the turns above STAYS as it is now. Read the dropped turns above: if\n' +
      'they contain rewards or injuries you also want undone, hand-edit those two files yourself.',
  );

  // A retire note inside the cut range is its own, louder problem: rewinding
  // across it puts the story back before a hero who no longer exists in
  // character.json, and no amount of hand-editing short of restoring a backup
  // will make that coherent.
  const retireNotes = dropped.filter((e) => e.role === 'system');
  if (retireNotes.length > 0) {
    console.log('');
    console.log(
      `WARNING: ${retireNotes.length} hero-retirement note(s) are inside this range. Rewinding past a\n` +
        'retirement rewinds the story to a hero that character.json has already replaced:',
    );
    retireNotes.forEach((e) => console.log(`   - ${e.text.replace(/\s+/g, ' ').slice(0, 110)}`));
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to rewind.');
    return;
  }

  const bak = backup(file);
  const kept = entries.slice(0, cut);
  fs.writeFileSync(file, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''));
  console.log(`\nRewound. Backup: ${path.basename(bak)}`);
  console.log('Restart the server, then reopen the campaign — the story log will resume from the earlier point.');
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]).endsWith('rewind.ts');
if (isDirectRun) main();
