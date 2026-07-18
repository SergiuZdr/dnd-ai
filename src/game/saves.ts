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

function savePaths(baseDir: string, slug: string): SavePaths {
  const dir = path.join(baseDir, slug);
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
    world: readJson<World>(paths.world),
    chronicle: readJson<Chronicle>(paths.chronicle),
  };
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
    const campaignFile = path.join(baseDir, entry.name, 'campaign.json');
    try {
      const campaign = readJson<Campaign>(campaignFile);
      listings.push({ slug: campaign.slug, name: campaign.name, updatedAt: campaign.updatedAt });
    } catch {
      // Tolerate junk directories / unreadable or corrupt campaign files.
      continue;
    }
  }

  listings.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return listings;
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
