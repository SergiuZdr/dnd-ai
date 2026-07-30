// Filesystem persistence: saves/<slug>/{campaign,character,world,chronicle}.json + transcript.jsonl
// Every JSON file is an envelope { schemaVersion, data }. Writes are atomic (tmp + rename).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { GameState, Campaign, Character, World, Chronicle } from './state';
import { SCHEMA_VERSION } from './state';

export interface CampaignListing {
  slug: string;
  name: string;
  updatedAt: string;
  /**
   * Who and where you left off, for the campaign picker. Optional because a
   * campaign directory can legitimately hold a readable campaign.json but a
   * missing or corrupt character/world (a half-written new campaign, a
   * hand-edited save) -- that must still list and still be resumable, just
   * without the flavour line. Never throws; see listCampaigns().
   */
  hero?: {
    name: string;
    race: string;
    className: string;
    level: number;
    hp: number;
    maxHp: number;
    location: string;
  };
}

export interface TranscriptEntry {
  role: 'player' | 'dm' | 'system';
  text: string;
  ts: string;
}

const envelopeSchema = z.object({
  schemaVersion: z.number(),
  data: z.unknown(),
});

const transcriptEntrySchema = z.object({
  role: z.enum(['player', 'dm', 'system']),
  text: z.string(),
  ts: z.string(),
});

function defaultBaseDir(): string {
  return path.join(process.cwd(), 'saves');
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'campaign';
}

interface SavePaths {
  dir: string;
  campaign: string;
  character: string;
  world: string;
  chronicle: string;
  transcript: string;
}

/**
 * Every read and write of a campaign resolves its directory here, which makes
 * this the one place that can guarantee a slug stays inside its own save root.
 *
 * That guarantee is load-bearing for multiplayer: per-player isolation works by
 * handing each request `playerSavesDir(root, playerId)` as its baseDir, so a
 * slug that escapes that directory escapes the isolation with it. `path.join`
 * happily normalises "../alice/secret" into a sibling player's campaign, and
 * slugs arrive straight from the client on /api/continue, so a plain join let
 * one player read (and, once deletion exists, destroy) another's saves purely
 * by asking for a crafted slug. Verified exploitable before this guard existed.
 *
 * Throws rather than sanitising: a slug that needed rewriting was not a slug
 * this server issued, and quietly redirecting it to some neighbouring
 * directory would be worse than refusing.
 */
function savePaths(baseDir: string, slug: string): SavePaths {
  const root = path.resolve(baseDir);
  const dir = path.resolve(root, slug);
  if (dir === root || !dir.startsWith(root + path.sep)) {
    throw new Error(`Invalid campaign slug "${slug}": resolves outside its save directory.`);
  }
  return {
    dir,
    campaign: path.join(dir, 'campaign.json'),
    character: path.join(dir, 'character.json'),
    world: path.join(dir, 'world.json'),
    chronicle: path.join(dir, 'chronicle.json'),
    transcript: path.join(dir, 'transcript.jsonl'),
  };
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const envelope = { schemaVersion: SCHEMA_VERSION, data };
  const tmpPath = path.join(dir, `${path.basename(filePath)}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Reads one save file's envelope. A schemaVersion NEWER than this build
 * understands is a hard error (nothing we can do); OLDER runs through
 * `migrate` (defaulting to an identity pass-through) so a save written by an
 * earlier version of the game keeps loading instead of throwing.
 */
function readJson<T>(filePath: string, migrate: (data: unknown, fromVersion: number) => T = (data) => data as T): T {
  const raw = fs.readFileSync(filePath, 'utf8');
  const envelope = envelopeSchema.parse(JSON.parse(raw));
  if (envelope.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `Schema version mismatch in ${filePath}: found ${envelope.schemaVersion}, expected ${SCHEMA_VERSION}.`,
    );
  }
  return migrate(envelope.data, envelope.schemaVersion);
}

// v1 -> v2: Character gained `luck` (default 1) and `background`/`backgroundFact`
// (default ''). campaign/world/chronicle shapes are unchanged across v1 -> v2,
// so they use readJson's identity-migrate default.
function migrateCharacter(data: unknown, fromVersion: number): Character {
  const character = data as Character;
  if (fromVersion < 2) {
    if (typeof character.luck !== 'number') character.luck = 1;
    if (typeof character.background !== 'string') character.background = '';
    if (typeof character.backgroundFact !== 'string') character.backgroundFact = '';
  }
  return character;
}

// v2 -> v3: every existing Quest gained `reward` (default ''). campaign/
// character/chronicle shapes are unchanged across v2 -> v3.
function migrateWorld(data: unknown, fromVersion: number): World {
  const world = data as World;
  if (fromVersion < 3) {
    for (const quest of world.quests) {
      if (typeof quest.reward !== 'string') quest.reward = '';
    }
  }
  return world;
}

export function saveGame(state: GameState, baseDir: string = defaultBaseDir()): void {
  state.campaign.updatedAt = new Date().toISOString();
  const paths = savePaths(baseDir, state.campaign.slug);
  writeJsonAtomic(paths.campaign, state.campaign);
  writeJsonAtomic(paths.character, state.character);
  writeJsonAtomic(paths.world, state.world);
  writeJsonAtomic(paths.chronicle, state.chronicle);
}

export function loadGame(slug: string, baseDir: string = defaultBaseDir()): GameState {
  const paths = savePaths(baseDir, slug);
  return {
    campaign: readJson<Campaign>(paths.campaign),
    character: readJson<Character>(paths.character, migrateCharacter),
    world: readJson<World>(paths.world, migrateWorld),
    chronicle: readJson<Chronicle>(paths.chronicle),
  };
}

/**
 * Best-effort hero/location line for the campaign picker. Deliberately
 * swallows every failure and returns undefined instead: this is decoration for
 * a list, and a campaign with an unreadable character.json must still be
 * listed (and resumed) rather than vanish from the picker. Runs the same
 * migrations as loadGame so an older save still reads.
 */
function readHeroSummary(baseDir: string, slug: string): CampaignListing['hero'] {
  try {
    const paths = savePaths(baseDir, slug);
    const character = readJson<Character>(paths.character, migrateCharacter);
    const world = readJson<World>(paths.world, migrateWorld);
    return {
      name: character.name,
      race: character.race,
      className: character.className,
      level: character.level,
      hp: character.hp,
      maxHp: character.maxHp,
      location: world.location,
    };
  } catch {
    return undefined;
  }
}

export function listCampaigns(baseDir: string = defaultBaseDir()): CampaignListing[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const listings: CampaignListing[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Retired campaigns live one level deeper so they'd be skipped anyway, but
    // say it outright: .deleted/ is not a campaign and must never be listed.
    if (entry.name === TRASH_DIR) continue;
    const campaignFile = path.join(baseDir, entry.name, 'campaign.json');
    try {
      const campaign = readJson<Campaign>(campaignFile);
      listings.push({
        slug: campaign.slug,
        name: campaign.name,
        updatedAt: campaign.updatedAt,
        hero: readHeroSummary(baseDir, campaign.slug),
      });
    } catch {
      // Tolerate junk directories / unreadable or corrupt campaign files.
      continue;
    }
  }

  listings.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return listings;
}

/** Where deleteCampaign() moves retired saves. listCampaigns() skips it by name explicitly (see there); scripts/admin/migrate-to-players.ts never mistakes it for a campaign either, since a deleted save sits one level deeper and so has no campaign.json directly inside. Dot-prefixed on top of that, to stay out of the way of shell globs and finder listings. */
export const TRASH_DIR = '.deleted';

/**
 * Retires a campaign by MOVING it into <baseDir>/.deleted/<slug>-<timestamp>/
 * rather than unlinking it.
 *
 * A campaign can represent weeks of play and there is no undo in the UI, so an
 * irreversible rm on a single mis-tap is the wrong default. A rename is atomic,
 * instant, and leaves the owner a folder to drag back if they change their
 * mind. Returns the path it was moved to.
 *
 * Goes through savePaths(), so it inherits the containment check -- a crafted
 * slug cannot reach out of this player's directory and delete someone else's
 * campaign.
 */
export function deleteCampaign(slug: string, baseDir: string = defaultBaseDir()): string {
  const paths = savePaths(baseDir, slug);
  if (!fs.existsSync(paths.campaign)) {
    throw new Error(`Campaign "${slug}" not found.`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(baseDir, TRASH_DIR, `${path.basename(paths.dir)}-${stamp}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(paths.dir, destination);
  return destination;
}

export function latestCampaign(baseDir: string = defaultBaseDir()): CampaignListing | null {
  const listings = listCampaigns(baseDir);
  return listings[0] ?? null;
}

export function appendTranscript(
  slug: string,
  entry: TranscriptEntry,
  baseDir: string = defaultBaseDir(),
): void {
  const paths = savePaths(baseDir, slug);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.appendFileSync(paths.transcript, `${JSON.stringify(entry)}\n`, 'utf8');
}

export function readTranscript(slug: string, baseDir: string = defaultBaseDir()): TranscriptEntry[] {
  const paths = savePaths(baseDir, slug);
  let raw: string;
  try {
    raw = fs.readFileSync(paths.transcript, 'utf8');
  } catch {
    return [];
  }

  const entries: TranscriptEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(transcriptEntrySchema.parse(JSON.parse(line)));
    } catch {
      // Skip corrupt lines.
      continue;
    }
  }
  return entries;
}
