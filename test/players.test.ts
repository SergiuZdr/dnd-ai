// Tests for the player registry + access-code auth (src/game/players.ts).
// Everything runs against a real tmpdir -- these are cheap file operations and
// the on-disk envelope/permissions are part of the contract.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addPlayer,
  authenticate,
  generateAccessCode,
  hasPlayers,
  hashCode,
  listPlayers,
  loadPlayers,
  normalizeCode,
  playerIdFromName,
  playerSavesDir,
  revokePlayer,
  rotateCode,
  savePlayers,
  touchLastSeen,
  PLAYERS_FILE,
} from '../src/game/players';

let baseDir: string;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-players-test-'));
});

afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('access codes', () => {
  it('generates 96 bits as six readable hex groups', () => {
    const code = generateAccessCode();
    expect(code).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){5}$/);
    expect(normalizeCode(code)).toHaveLength(24); // 12 bytes
  });

  it('generates distinct codes', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateAccessCode()));
    expect(codes.size).toBe(200);
  });

  it('treats dashes, spaces and case as insignificant, since players retype these by hand', () => {
    const canonical = hashCode('7f3a-9c21-be04-1d8e-33ba-90cd');
    expect(hashCode('7f3a9c21be041d8e33ba90cd')).toBe(canonical);
    expect(hashCode('7F3A-9C21-BE04-1D8E-33BA-90CD')).toBe(canonical);
    expect(hashCode(' 7f3a 9c21 be04 1d8e 33ba 90cd ')).toBe(canonical);
  });
});

describe('playerIdFromName', () => {
  it('slugifies to a filesystem-safe id', () => {
    expect(playerIdFromName('Sergiu')).toBe('sergiu');
    expect(playerIdFromName('  Friend One!  ')).toBe('friend-one');
    expect(playerIdFromName('a/../../etc/passwd')).toBe('a-etc-passwd');
  });

  it('never yields an empty id, even for a name with no usable characters', () => {
    expect(playerIdFromName('!!!')).toMatch(/^player-[0-9a-f]{6}$/);
  });

  it('cannot produce a path that escapes the players directory', () => {
    const id = playerIdFromName('../../escape');
    const resolved = path.resolve(playerSavesDir(baseDir, id));
    expect(resolved.startsWith(path.resolve(baseDir))).toBe(true);
  });
});

describe('addPlayer / authenticate', () => {
  it('creates a player, returns the code once, and stores only its hash', () => {
    const { player, code } = addPlayer(baseDir, 'Sergiu');
    expect(player.id).toBe('sergiu');
    expect(player.lastSeenAt).toBeNull();

    const onDisk = fs.readFileSync(path.join(baseDir, PLAYERS_FILE), 'utf8');
    expect(onDisk).not.toContain(normalizeCode(code)); // the code itself is never persisted
    expect(onDisk).toContain(hashCode(code));
  });

  it('authenticates the right player and rejects everything else', () => {
    const a = addPlayer(baseDir, 'Alice');
    const b = addPlayer(baseDir, 'Bob');

    expect(authenticate(baseDir, a.code)?.id).toBe('alice');
    expect(authenticate(baseDir, b.code)?.id).toBe('bob');
    expect(authenticate(baseDir, generateAccessCode())).toBeUndefined();
    expect(authenticate(baseDir, '')).toBeUndefined();
    expect(authenticate(baseDir, undefined)).toBeUndefined();
    expect(authenticate(baseDir, '   ---   ')).toBeUndefined();
  });

  it('accepts a code typed without its dashes', () => {
    const { code } = addPlayer(baseDir, 'Alice');
    expect(authenticate(baseDir, normalizeCode(code))?.id).toBe('alice');
  });

  it('refuses two players whose names collide into one id -- they would share a save directory', () => {
    addPlayer(baseDir, 'Friend One');
    expect(() => addPlayer(baseDir, 'friend-one')).toThrow(/already exists/);
    expect(listPlayers(baseDir)).toHaveLength(1);
  });

  it('creates the player save directory', () => {
    const { player } = addPlayer(baseDir, 'Sergiu');
    expect(fs.existsSync(playerSavesDir(baseDir, player.id))).toBe(true);
  });
});

describe('rotateCode / revokePlayer', () => {
  it('rotating invalidates the previous code', () => {
    const { code: original } = addPlayer(baseDir, 'Alice');
    const rotated = rotateCode(baseDir, 'alice');
    expect(rotated).toBeDefined();
    expect(authenticate(baseDir, original)).toBeUndefined();
    expect(authenticate(baseDir, rotated!.code)?.id).toBe('alice');
  });

  it('rotating an unknown player reports rather than throws', () => {
    expect(rotateCode(baseDir, 'nobody')).toBeUndefined();
  });

  it('revoking stops the code working but leaves the campaigns on disk', () => {
    const { code, player } = addPlayer(baseDir, 'Bob');
    const dir = playerSavesDir(baseDir, player.id);
    fs.writeFileSync(path.join(dir, 'marker.txt'), 'a campaign lived here');

    expect(revokePlayer(baseDir, 'bob')).toBe(true);
    expect(authenticate(baseDir, code)).toBeUndefined();
    // Revoking access must never be destructive against someone's save.
    expect(fs.existsSync(path.join(dir, 'marker.txt'))).toBe(true);
  });

  it('revoking an unknown player returns false', () => {
    expect(revokePlayer(baseDir, 'nobody')).toBe(false);
  });

  it('revoking one player leaves the others working', () => {
    const a = addPlayer(baseDir, 'Alice');
    const b = addPlayer(baseDir, 'Bob');
    revokePlayer(baseDir, 'alice');
    expect(authenticate(baseDir, a.code)).toBeUndefined();
    expect(authenticate(baseDir, b.code)?.id).toBe('bob');
  });
});

describe('registry robustness', () => {
  it('reports no players when the registry is absent', () => {
    expect(hasPlayers(baseDir)).toBe(false);
    expect(loadPlayers(baseDir)).toEqual({ players: [] });
  });

  it('degrades to "no players" on a corrupt registry rather than throwing', () => {
    // A throw here would take the whole server down on boot; single-player PIN
    // mode is the safe fallback.
    fs.writeFileSync(path.join(baseDir, PLAYERS_FILE), '{ not json');
    expect(() => loadPlayers(baseDir)).not.toThrow();
    expect(hasPlayers(baseDir)).toBe(false);
    expect(authenticate(baseDir, generateAccessCode())).toBeUndefined();
  });

  it('drops malformed rows instead of trusting them', () => {
    savePlayers(baseDir, {
      players: [
        { id: 'ok', name: 'Ok', codeHash: hashCode('abc'), createdAt: '', lastSeenAt: null },
        { id: 'broken' } as never,
        null as never,
      ],
    });
    expect(loadPlayers(baseDir).players.map((p) => p.id)).toEqual(['ok']);
  });

  it('writes the registry with owner-only permissions', () => {
    addPlayer(baseDir, 'Alice');
    const mode = fs.statSync(path.join(baseDir, PLAYERS_FILE)).mode & 0o777;
    expect(mode & 0o077).toBe(0); // no group/other access
  });

  it('survives a round-trip through save/load', () => {
    const { code } = addPlayer(baseDir, 'Alice');
    const reloaded = loadPlayers(baseDir);
    savePlayers(baseDir, reloaded);
    expect(authenticate(baseDir, code)?.id).toBe('alice');
  });
});

describe('touchLastSeen', () => {
  it('records a timestamp for a known player', () => {
    addPlayer(baseDir, 'Alice');
    touchLastSeen(baseDir, 'alice');
    expect(listPlayers(baseDir)[0].lastSeenAt).toBeTruthy();
  });

  it('is a no-op for an unknown player and never throws', () => {
    expect(() => touchLastSeen(baseDir, 'nobody')).not.toThrow();
  });
});
