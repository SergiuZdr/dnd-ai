// Owner CLI for the web server's player registry (src/game/players.ts).
//
//   npx tsx scripts/admin/players.ts list
//   npx tsx scripts/admin/players.ts add "Sergiu"
//   npx tsx scripts/admin/players.ts rotate sergiu
//   npx tsx scripts/admin/players.ts revoke sergiu
//
// All commands accept --saves-dir <path> (default: ./saves; on the deployed
// host that's whatever SAVES_DIR points at, e.g. /opt/dnd/saves).
//
// `add` and `rotate` print the access code ONCE. It is not recoverable
// afterwards -- only its SHA-256 is stored -- so if it's lost, rotate and hand
// out the new one.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  addPlayer,
  listPlayers,
  playerSavesDir,
  revokePlayer,
  rotateCode,
} from '../../src/game/players';

function parseSavesDir(argv: string[]): string {
  const i = argv.indexOf('--saves-dir');
  return i !== -1 && argv[i + 1] ? argv[i + 1] : path.join(process.cwd(), 'saves');
}

/** How many campaign directories a player currently has -- purely informational for `list`. */
function campaignCount(baseDir: string, id: string): number {
  try {
    return fs
      .readdirSync(playerSavesDir(baseDir, id), { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(playerSavesDir(baseDir, id), e.name, 'campaign.json')))
      .length;
  } catch {
    return 0;
  }
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins)) return 'unknown';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function printCode(name: string, id: string, code: string): void {
  console.log('');
  console.log(`  player : ${name}  (id: ${id})`);
  console.log(`  code   : ${code}`);
  console.log('');
  console.log('  Give this to the player -- it is their login. Shown once and');
  console.log('  not recoverable; run `rotate` to issue a replacement.');
  console.log('');
}

function main(): void {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const baseDir = parseSavesDir(argv);

  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log('Usage: npx tsx scripts/admin/players.ts <list|add|rotate|revoke> [name|id] [--saves-dir <path>]');
    process.exit(cmd ? 0 : 1);
  }

  if (cmd === 'list') {
    const players = listPlayers(baseDir);
    if (players.length === 0) {
      console.log(`No players registered in ${baseDir}.`);
      console.log('The server is in single-player mode: the shared GAME_PIN gates everything.');
      console.log('Add the first player to switch it to per-player access codes.');
      return;
    }
    console.log(`${players.length} player(s) in ${baseDir}:\n`);
    console.log(`  ${'ID'.padEnd(20)}${'NAME'.padEnd(20)}${'CAMPAIGNS'.padEnd(12)}LAST SEEN`);
    for (const p of players) {
      console.log(
        `  ${p.id.padEnd(20)}${p.name.padEnd(20)}${String(campaignCount(baseDir, p.id)).padEnd(12)}${relativeTime(p.lastSeenAt)}`,
      );
    }
    return;
  }

  if (cmd === 'add') {
    const name = argv[1];
    if (!name || name.startsWith('--')) {
      console.error('Usage: npx tsx scripts/admin/players.ts add "<name>"');
      process.exit(1);
    }
    let result;
    try {
      result = addPlayer(baseDir, name);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
    printCode(result.player.name, result.player.id, result.code);
    if (listPlayers(baseDir).length === 1) {
      console.log('  This is the first player, so the server has just switched from');
      console.log('  shared-PIN mode to per-player access codes. Restart it, and run');
      console.log('  scripts/admin/migrate-to-players.ts if you have existing campaigns.');
      console.log('');
    }
    return;
  }

  if (cmd === 'rotate') {
    const id = argv[1];
    if (!id || id.startsWith('--')) {
      console.error('Usage: npx tsx scripts/admin/players.ts rotate <id>');
      process.exit(1);
    }
    const result = rotateCode(baseDir, id);
    if (!result) {
      console.error(`No player with id "${id}". Run \`list\` to see ids.`);
      process.exit(1);
    }
    console.log('Previous code is now invalid.');
    printCode(result.player.name, result.player.id, result.code);
    return;
  }

  if (cmd === 'revoke') {
    const id = argv[1];
    if (!id || id.startsWith('--')) {
      console.error('Usage: npx tsx scripts/admin/players.ts revoke <id>');
      process.exit(1);
    }
    if (!revokePlayer(baseDir, id)) {
      console.error(`No player with id "${id}". Run \`list\` to see ids.`);
      process.exit(1);
    }
    console.log(`Revoked "${id}" -- their code no longer works.`);
    console.log(`Their campaigns are left untouched at ${playerSavesDir(baseDir, id)}`);
    console.log('(delete that folder by hand if you actually want the saves gone).');
    return;
  }

  console.error(`Unknown command "${cmd}". Expected list, add, rotate or revoke.`);
  process.exit(1);
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]).endsWith('players.ts');
if (isDirectRun) main();
