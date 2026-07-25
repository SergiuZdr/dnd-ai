// Unit tests for src/web/serve.ts's pure env/CLI resolution helpers (P2
// cloud-deploy config). Deliberately does NOT import the module's default
// export or trigger `main()` -- serve.ts guards its actual server-boot/
// SIGINT-SIGTERM-registration side effects behind an `isDirectRun` check so
// importing it here (as vitest does, not as `tsx src/web/serve.ts`) is safe
// and never binds a real socket.

import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  resolvePort,
  resolveHost,
  resolvePin,
  resolveSavesDir,
  pinCameFromEnv,
  startupBoxLines,
} from '../src/web/serve';
import type { CliArgs } from '../src/web/serve';

const NO_FLAGS: CliArgs = { port: 3123, host: '0.0.0.0', noPin: false, debug: false };

describe('parseArgs', () => {
  it('defaults to port 3123, host 0.0.0.0, pin enabled, debug off', () => {
    expect(parseArgs([])).toEqual(NO_FLAGS);
  });

  it('parses --port/--host/--no-pin/--debug', () => {
    expect(parseArgs(['--port', '4000', '--host', '127.0.0.1', '--no-pin', '--debug'])).toEqual({
      port: 4000,
      host: '127.0.0.1',
      noPin: true,
      debug: true,
    });
  });

  it('ignores a non-numeric/non-positive --port, keeping the default', () => {
    expect(parseArgs(['--port', 'abc']).port).toBe(3123);
    expect(parseArgs(['--port', '-1']).port).toBe(3123);
    expect(parseArgs(['--port', '0']).port).toBe(3123);
  });
});

describe('resolvePort (PORT env > --port flag > default)', () => {
  it('falls back to args.port with no PORT env set', () => {
    expect(resolvePort(NO_FLAGS, {})).toBe(3123);
    expect(resolvePort({ ...NO_FLAGS, port: 4000 }, {})).toBe(4000);
  });

  it('PORT env overrides args.port', () => {
    expect(resolvePort({ ...NO_FLAGS, port: 4000 }, { PORT: '8080' })).toBe(8080);
  });

  it('ignores a non-numeric/non-positive PORT env, falling back to args.port', () => {
    expect(resolvePort(NO_FLAGS, { PORT: 'not-a-number' })).toBe(3123);
    expect(resolvePort(NO_FLAGS, { PORT: '-5' })).toBe(3123);
    expect(resolvePort(NO_FLAGS, { PORT: '0' })).toBe(3123);
  });

  it('treats a blank/whitespace PORT as unset', () => {
    expect(resolvePort({ ...NO_FLAGS, port: 4000 }, { PORT: '   ' })).toBe(4000);
  });
});

describe('resolveHost (HOST env > --host flag > default)', () => {
  it('falls back to args.host with no HOST env set', () => {
    expect(resolveHost(NO_FLAGS, {})).toBe('0.0.0.0');
    expect(resolveHost({ ...NO_FLAGS, host: '127.0.0.1' }, {})).toBe('127.0.0.1');
  });

  it('HOST env overrides args.host', () => {
    expect(resolveHost({ ...NO_FLAGS, host: '127.0.0.1' }, { HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });

  it('treats a blank HOST as unset', () => {
    expect(resolveHost({ ...NO_FLAGS, host: '127.0.0.1' }, { HOST: '' })).toBe('127.0.0.1');
  });
});

describe('resolveSavesDir (SAVES_DIR env, no CLI equivalent)', () => {
  it('is undefined (createGameServer default: cwd/saves) with no SAVES_DIR set', () => {
    expect(resolveSavesDir({})).toBeUndefined();
  });

  it('SAVES_DIR env is passed through as baseDir', () => {
    expect(resolveSavesDir({ SAVES_DIR: '/data/saves' })).toBe('/data/saves');
  });

  it('treats a blank SAVES_DIR as unset', () => {
    expect(resolveSavesDir({ SAVES_DIR: '  ' })).toBeUndefined();
  });
});

describe('resolvePin (--no-pin > GAME_PIN env > generated)', () => {
  it('generates a pin via the injected generator with no GAME_PIN and no --no-pin', () => {
    expect(resolvePin(NO_FLAGS, {}, () => 'GENERATED')).toBe('GENERATED');
  });

  it('GAME_PIN env is used as a fixed pin instead of generating one', () => {
    const generator = () => {
      throw new Error('should not be called when GAME_PIN is set');
    };
    expect(resolvePin(NO_FLAGS, { GAME_PIN: '482913' }, generator)).toBe('482913');
  });

  it('--no-pin wins over GAME_PIN -- pin stays disabled even if GAME_PIN is set', () => {
    const args: CliArgs = { ...NO_FLAGS, noPin: true };
    expect(resolvePin(args, { GAME_PIN: '482913' }, () => 'GENERATED')).toBeUndefined();
  });

  it('treats a blank GAME_PIN as unset, falling back to generation', () => {
    expect(resolvePin(NO_FLAGS, { GAME_PIN: '   ' }, () => 'GENERATED')).toBe('GENERATED');
  });

  it('with no env object passed at all (real process.env), still respects --no-pin', () => {
    expect(resolvePin({ ...NO_FLAGS, noPin: true })).toBeUndefined();
  });
});

describe('pinCameFromEnv', () => {
  it('is true only when GAME_PIN actually supplied the pin', () => {
    expect(pinCameFromEnv(NO_FLAGS, { GAME_PIN: '482913' })).toBe(true);
    expect(pinCameFromEnv(NO_FLAGS, {})).toBe(false);
    expect(pinCameFromEnv(NO_FLAGS, { GAME_PIN: '   ' })).toBe(false); // blank == unset
    expect(pinCameFromEnv({ ...NO_FLAGS, noPin: true }, { GAME_PIN: '482913' })).toBe(false);
  });
});

describe('startupBoxLines', () => {
  // The startup banner goes to journald on a systemd host, where it persists on
  // disk for anyone who can run `journalctl` -- so an operator-chosen PIN must
  // never be echoed into it.
  it('does NOT print a GAME_PIN-supplied pin, only its length', () => {
    const lines = startupBoxLines(['http://10.0.0.31:3123'], 3123, 'supersecret989090', true);
    expect(lines.join('\n')).not.toContain('supersecret989090');
    expect(lines.join('\n')).toContain('set from GAME_PIN');
    expect(lines.join('\n')).toContain('17 chars');
  });

  it('DOES print a locally generated pin -- the console is the only place it exists', () => {
    const lines = startupBoxLines(['http://192.168.1.23:3123'], 3123, '482913', false);
    expect(lines.join('\n')).toContain('PIN: 482913');
  });

  it('says so plainly when the pin is disabled entirely', () => {
    expect(startupBoxLines([], 3123, undefined, false).join('\n')).toContain('PIN disabled (--no-pin)');
  });

  it('falls back to a localhost line when no LAN interface was detected', () => {
    expect(startupBoxLines([], 4000, '482913', false).join('\n')).toContain('http://localhost:4000');
  });
});
