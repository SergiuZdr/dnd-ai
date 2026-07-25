// Moves pre-multiplayer campaigns into a player's own save directory:
//
//   <savesDir>/<slug>/                    ->  <savesDir>/players/<id>/<slug>/
//
// Before per-player access codes every campaign lived directly under the saves
// root and anyone with the shared PIN could open any of them. Assigning them to
// a player is what makes them private.
//
// Usage (dry run prints the plan and moves nothing):
//   npx tsx scripts/admin/migrate-to-players.ts --owner sergiu
//   npx tsx scripts/admin/migrate-to-players.ts --owner sergiu --apply
//   npx tsx scripts/admin/migrate-to-players.ts --owner sergiu --apply --saves-dir /opt/dnd/saves
//   npx tsx scripts/admin/migrate-to-players.ts --owner sergiu --apply --only "1st and best world"
//
// --apply tars the whole saves tree first. Stop the server before running it:
// a live GameController holds a campaign open and autosaves to the OLD path.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { PLAYERS_DIR, PLAYERS_FILE, listPlayers, playerSavesDir } from '../../src/game/players';

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : undefined;
}

/** A directory directly under the saves root that holds a real campaign -- i.e. not players/, not the registry file, and containing a campaign.json. */
function legacyCampaignSlugs(baseDir: string, only?: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name !== PLAYERS_DIR)
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(baseDir, name, 'campaign.json')))
    .filter((name) => (only ? name === only : true))
    .sort();
}

function main(): void {
  const argv = process.argv.slice(2);
  const baseDir = arg(argv, '--saves-dir') ?? path.join(process.cwd(), 'saves');
  const owner = arg(argv, '--owner');
  const only = arg(argv, '--only');
  const apply = argv.includes('--apply');

  if (!owner) {
    console.error('Usage: npx tsx scripts/admin/migrate-to-players.ts --owner <playerId> [--only <slug>] [--apply] [--saves-dir <path>]');
    process.exit(1);
  }

  const players = listPlayers(baseDir);
  if (players.length === 0) {
    console.error(`No players registered in ${baseDir}. Create one first:`);
    console.error('  npx tsx scripts/admin/players.ts add "<name>" --saves-dir ' + baseDir);
    process.exit(1);
  }
  const target = players.find((p) => p.id === owner);
  if (!target) {
    console.error(`No player with id "${owner}". Known ids: ${players.map((p) => p.id).join(', ')}`);
    process.exit(1);
  }

  const slugs = legacyCampaignSlugs(baseDir, only);
  const destRoot = playerSavesDir(baseDir, target.id);

  console.log(`${apply ? 'APPLYING' : 'DRY RUN (nothing moved -- pass --apply)'} in ${baseDir}`);
  console.log(`Owner: ${target.name} (${target.id}) -> ${destRoot}\n`);

  if (slugs.length === 0) {
    console.log('No legacy campaigns found directly under the saves root.');
    console.log(`(Already-migrated campaigns live under ${PLAYERS_DIR}/ and are left alone.)`);
    return;
  }

  // Refuse the whole run if any destination is occupied, rather than migrating
  // half of them and leaving the tree in a mixed state.
  const collisions = slugs.filter((s) => fs.existsSync(path.join(destRoot, s)));
  if (collisions.length > 0) {
    console.error(`REFUSING: these already exist under ${destRoot}:`);
    collisions.forEach((c) => console.error(`  - ${c}`));
    console.error('Move or remove them first, or use --only to migrate the rest individually.');
    process.exit(1);
  }

  for (const slug of slugs) {
    console.log(`  ${slug}/  ->  ${PLAYERS_DIR}/${target.id}/${slug}/`);
  }

  if (!apply) {
    console.log(`\n${slugs.length} campaign(s) would move. Re-run with --apply.`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(path.dirname(baseDir), `saves-premigration-${stamp}.tar.gz`);
  childProcess.execFileSync('tar', ['czf', backup, '-C', path.dirname(baseDir), path.basename(baseDir)]);
  console.log(`\nBackup: ${backup}`);

  fs.mkdirSync(destRoot, { recursive: true });
  for (const slug of slugs) {
    fs.renameSync(path.join(baseDir, slug), path.join(destRoot, slug));
    console.log(`  moved ${slug}`);
  }

  console.log(`\nMigrated ${slugs.length} campaign(s) to ${target.id}.`);
  console.log(`The registry (${PLAYERS_FILE}) and ${PLAYERS_DIR}/ stay at the saves root.`);
  console.log('Restart the server, then sign in with that player\'s access code.');
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]).endsWith('migrate-to-players.ts');
if (isDirectRun) main();
