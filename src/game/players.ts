// Per-player identity for the web server: a small registry of players, each
// holding one long random ACCESS CODE, plus the save-directory namespacing that
// keeps one player's campaigns invisible to another.
//
// Why access codes rather than username+password: the codes here are generated
// (96 bits from crypto.randomBytes), never chosen by a human. That removes the
// entire reason password hashing exists -- there is no weak-password guessing
// to slow down -- so these are stored as a plain SHA-256 digest, exactly the
// way session tokens and API keys are. scrypt/argon2 would only add latency to
// every request while defending against an attack (dictionary/brute force over
// a 2^96 space) that isn't reachable. It also means no password storage, no
// reset flow, and no login throttling to get subtly wrong; revoking a player is
// deleting one row.
//
// Layout under the saves dir:
//   <savesDir>/players.json                  the registry (this file's concern)
//   <savesDir>/players/<playerId>/<slug>/    one player's campaigns
//
// That last path is the whole isolation mechanism, and it needs no changes to
// saves.ts: every function there already takes a baseDir, so the server hands
// it playerSavesDir(...) instead of the shared root and per-player separation
// falls out of the existing seam.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export const PLAYERS_FILE = 'players.json';
export const PLAYERS_DIR = 'players';
export const SCHEMA_VERSION = 1;

export interface Player {
  /** Stable, filesystem-safe id -- also the directory name under players/. Never renamed, so a display-name change can't orphan a save. */
  id: string;
  /** What the owner typed when creating them; shown in CLI listings only. */
  name: string;
  /** Lowercase hex SHA-256 of the access code. The code itself is shown exactly once, at creation, and is not recoverable from here. */
  codeHash: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface PlayerRegistry {
  players: Player[];
}

/** Envelope on disk, matching saves.ts's { schemaVersion, data } convention. */
interface PlayersFile {
  schemaVersion: number;
  data: PlayerRegistry;
}

function registryPath(baseDir: string): string {
  return path.join(baseDir, PLAYERS_FILE);
}

/**
 * The directory holding one player's campaigns -- pass straight through as
 * saves.ts's `baseDir` and every existing save/load/list call becomes
 * player-scoped with no further changes.
 */
export function playerSavesDir(baseDir: string, playerId: string): string {
  return path.join(baseDir, PLAYERS_DIR, playerId);
}

/** Missing/unreadable/corrupt registry reads as "no players registered" rather than throwing -- the server treats that as single-player PIN mode, so a damaged file must not take the whole game down. */
export function loadPlayers(baseDir: string): PlayerRegistry {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(baseDir), 'utf8')) as PlayersFile;
    const players = raw?.data?.players;
    if (!Array.isArray(players)) return { players: [] };
    return { players: players.filter((p) => typeof p?.id === 'string' && typeof p?.codeHash === 'string') };
  } catch {
    return { players: [] };
  }
}

export function savePlayers(baseDir: string, registry: PlayerRegistry): void {
  fs.mkdirSync(baseDir, { recursive: true });
  const file: PlayersFile = { schemaVersion: SCHEMA_VERSION, data: registry };
  const target = registryPath(baseDir);
  // Same write-temp-then-rename the saves do, so an interrupted write can't
  // leave a half-written registry that locks everyone out.
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/** Lowercase, filesystem- and URL-safe slug of a display name; falls back to a random suffix if the name has no usable characters at all. */
export function playerIdFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug.length > 0 ? slug : `player-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * 96 bits of entropy, rendered as 6 groups of 4 hex for readability on a phone
 * ("7f3a-9c21-be04-1d8e-33ba-90cd"). Groups are cosmetic -- normalizeCode()
 * strips them before hashing, so a player may type it with or without dashes.
 */
export function generateAccessCode(): string {
  const hex = crypto.randomBytes(12).toString('hex');
  return (hex.match(/.{4}/g) ?? []).join('-');
}

/** Canonical form for hashing/comparison: dashes, spaces and case are all insignificant, because players retype these by hand. */
export function normalizeCode(code: string): string {
  return code.replace(/[\s-]/g, '').toLowerCase();
}

export function hashCode(code: string): string {
  return crypto.createHash('sha256').update(normalizeCode(code)).digest('hex');
}

export interface AddPlayerResult {
  player: Player;
  /** Plaintext, shown once. Not recoverable afterwards -- only its hash is stored. */
  code: string;
}

/** Creates a player with a fresh code. Throws if the derived id is already taken, so two players can never share a save directory. */
export function addPlayer(baseDir: string, name: string): AddPlayerResult {
  const registry = loadPlayers(baseDir);
  const id = playerIdFromName(name);
  if (registry.players.some((p) => p.id === id)) {
    throw new Error(`A player with id "${id}" already exists.`);
  }
  const code = generateAccessCode();
  const player: Player = {
    id,
    name: name.trim() || id,
    codeHash: hashCode(code),
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
  };
  registry.players.push(player);
  savePlayers(baseDir, registry);
  fs.mkdirSync(playerSavesDir(baseDir, id), { recursive: true });
  return { player, code };
}

/** Issues a new code for an existing player, invalidating the old one. Returns undefined if there's no such player. */
export function rotateCode(baseDir: string, id: string): AddPlayerResult | undefined {
  const registry = loadPlayers(baseDir);
  const player = registry.players.find((p) => p.id === id);
  if (!player) return undefined;
  const code = generateAccessCode();
  player.codeHash = hashCode(code);
  savePlayers(baseDir, registry);
  return { player, code };
}

/**
 * Removes a player from the registry so their code stops working. Deliberately
 * leaves their save directory on disk: revoking access should never be a
 * destructive act against someone's campaign, and the owner can delete the
 * folder by hand if they actually mean to.
 */
export function revokePlayer(baseDir: string, id: string): boolean {
  const registry = loadPlayers(baseDir);
  const before = registry.players.length;
  registry.players = registry.players.filter((p) => p.id !== id);
  if (registry.players.length === before) return false;
  savePlayers(baseDir, registry);
  return true;
}

export function listPlayers(baseDir: string): Player[] {
  return loadPlayers(baseDir).players;
}

/** True when any player is registered -- the server's switch between multi-player (access codes) and legacy single-player (shared PIN) mode. */
export function hasPlayers(baseDir: string): boolean {
  return loadPlayers(baseDir).players.length > 0;
}

/**
 * Resolves an access code to a player, or undefined. Compares digests with
 * timingSafeEqual: the codes are far too large to guess, but a comparison that
 * short-circuits on the first differing byte is still a habit worth not
 * forming in an auth path.
 */
export function authenticate(baseDir: string, code: string | undefined): Player | undefined {
  if (!code || normalizeCode(code).length === 0) return undefined;
  const candidate = Buffer.from(hashCode(code), 'hex');
  for (const player of loadPlayers(baseDir).players) {
    let stored: Buffer;
    try {
      stored = Buffer.from(player.codeHash, 'hex');
    } catch {
      continue;
    }
    if (stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate)) {
      return player;
    }
  }
  return undefined;
}

/** Best-effort "last seen" bookkeeping for the CLI listing; never throws, and a failure to record it must not fail the request that triggered it. */
export function touchLastSeen(baseDir: string, id: string): void {
  try {
    const registry = loadPlayers(baseDir);
    const player = registry.players.find((p) => p.id === id);
    if (!player) return;
    player.lastSeenAt = new Date().toISOString();
    savePlayers(baseDir, registry);
  } catch {
    /* ignore */
  }
}
