// CLI entry point for phone/web play: `npm run serve` (optionally
// `-- --port 4000 --host 127.0.0.1 --no-pin --debug`). Boots
// createGameServer() (server.ts), prints a startup box with every LAN URL
// the phone could reach it at plus the PIN, and shuts the active
// GameController down cleanly on SIGINT/SIGTERM so a mid-turn Ctrl+C still
// autosaves (same guarantee App.tsx's unmount cleanup gives the TUI).
//
// Why plain http + SSE instead of a WebSocket library: Node's stdlib has
// `http` but no WS server, and this project takes no new dependencies.
// Server-Sent Events (server.ts's /api/events) cover a turn-based game
// fine and give reconnect-on-drop for free via the browser's EventSource --
// exactly what a phone needs across screen locks and network blips.
//
// P2 (cloud deploy) env config: a container/VM sets everything via env vars
// instead of CLI flags (there's no shell to pass `--port`/`--host` to). Each
// of PORT/HOST/GAME_PIN/SAVES_DIR below has a pure resolve*() function with
// the precedence env > --flag > built-in default, and every one has a safe
// fallback so `npm run serve` with NO env vars set behaves exactly as before
// P2 shipped. GAME_PIN in particular matters for the cloud: the CLI's
// generatePin() makes a fresh random PIN every boot, which is fine for a
// laptop dev session but useless once a host can restart the process
// without the owner watching the console for the new PIN.
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createGameServer } from './server';

const DEFAULT_PORT = 3123;
const DEFAULT_HOST = '0.0.0.0';

export interface CliArgs {
  port: number;
  host: string;
  noPin: boolean;
  debug: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { port: DEFAULT_PORT, host: DEFAULT_HOST, noPin: false, debug: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') {
      const value = Number(argv[++i]);
      if (Number.isInteger(value) && value > 0) args.port = value;
    } else if (arg === '--host') {
      args.host = argv[++i] ?? args.host;
    } else if (arg === '--no-pin') {
      args.noPin = true;
    } else if (arg === '--debug') {
      args.debug = true;
    }
  }
  return args;
}

/** undefined/empty/whitespace-only -> undefined, so a set-but-blank env var behaves like it's unset. */
function nonEmptyEnv(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** PORT env -> --port flag (already folded into args.port by parseArgs) -> DEFAULT_PORT. Ignores a non-numeric/non-positive PORT rather than crash the boot over a typo'd env var. */
export function resolvePort(args: CliArgs, env: NodeJS.ProcessEnv = process.env): number {
  const raw = nonEmptyEnv(env.PORT);
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return args.port;
}

/** HOST env -> --host flag -> DEFAULT_HOST ('0.0.0.0', already args.host's own default). */
export function resolveHost(args: CliArgs, env: NodeJS.ProcessEnv = process.env): string {
  return nonEmptyEnv(env.HOST) ?? args.host;
}

/** SAVES_DIR env -> undefined (createGameServer's own default: cwd/saves). Lets a cloud deploy point saves at a mounted volume without editing code. */
export function resolveSavesDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return nonEmptyEnv(env.SAVES_DIR);
}

/**
 * --no-pin -> undefined (no PIN at all, unaffected by GAME_PIN). Otherwise
 * GAME_PIN env (a fixed secret set once, e.g. via `fly secrets set` --
 * survives restarts, unlike a freshly generated one) -> a freshly generated
 * random PIN (the pre-P2 local-dev default, printed to the console each
 * boot). `pinGenerator` is a test seam so tests don't depend on real
 * randomness to assert "a PIN was generated."
 */
export function resolvePin(
  args: CliArgs,
  env: NodeJS.ProcessEnv = process.env,
  pinGenerator: () => string = generatePin,
): string | undefined {
  if (args.noPin) return undefined;
  return nonEmptyEnv(env.GAME_PIN) ?? pinGenerator();
}

/** All non-internal IPv4 addresses of this machine -- what a phone on the same LAN/Wi-Fi could actually reach. */
function lanUrls(port: number): string[] {
  const urls: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const addr of addresses ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        urls.push(`http://${addr.address}:${port}`);
      }
    }
  }
  return urls;
}

/** 6 digits, cryptographically random (crypto.randomInt) -- a lock against someone stumbling onto the port, not real auth (see the README warning about never port-forwarding this). */
function generatePin(): string {
  return crypto.randomInt(100_000, 1_000_000).toString();
}

/**
 * True when the PIN was supplied by the operator via GAME_PIN rather than
 * generated here. Drives whether printStartupBox() prints the PIN in the clear:
 * a generated PIN exists nowhere else, so the console is the only place it can
 * be learned, but a GAME_PIN was chosen by whoever set it and echoing it just
 * copies a password into the log. On a systemd host that log is journald --
 * written to disk and readable by anyone who can run `journalctl`, for every
 * boot in the retention window.
 */
export function pinCameFromEnv(args: CliArgs, env: NodeJS.ProcessEnv = process.env): boolean {
  if (args.noPin) return false;
  return nonEmptyEnv(env.GAME_PIN) !== undefined;
}

export function startupBoxLines(
  urls: string[],
  port: number,
  pin: string | undefined,
  pinFromEnv = false,
): string[] {
  let pinLine: string;
  if (!pin) {
    pinLine = 'PIN disabled (--no-pin) -- anyone who can reach this port can play.';
  } else if (pinFromEnv) {
    // Deliberately NOT the value: it is already in GAME_PIN, and this line
    // otherwise ends up in journald/`docker logs` forever.
    pinLine = `PIN: set from GAME_PIN (${pin.length} chars, not shown)`;
  } else {
    pinLine = `PIN: ${pin}`;
  }
  return [
    'AI Dungeon Master -- phone/web mode',
    '',
    ...(urls.length > 0 ? urls : [`http://localhost:${port} (no LAN interface detected)`]),
    '',
    pinLine,
  ];
}

function printStartupBox(urls: string[], port: number, pin: string | undefined, pinFromEnv: boolean): void {
  const lines = startupBoxLines(urls, port, pin, pinFromEnv);
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const border = '─'.repeat(width);
  console.log(`┌${border}┐`);
  for (const line of lines) {
    console.log(`│ ${line.padEnd(width - 2)} │`);
  }
  console.log(`└${border}┘`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const port = resolvePort(args);
  const host = resolveHost(args);
  const pin = resolvePin(args);
  const baseDir = resolveSavesDir();

  const { server, shutdown } = createGameServer({ pin, debug: args.debug, baseDir });

  const pinFromEnv = pinCameFromEnv(args);

  server.listen(port, host, () => {
    printStartupBox(lanUrls(port), port, pin, pinFromEnv);
  });

  let shuttingDown = false;
  async function handleShutdownSignal(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[${signal}] Saving and shutting down...`);
    try {
      await shutdown();
    } finally {
      server.close(() => process.exit(0));
      // Belt-and-suspenders: don't hang forever if a stuck SSE socket keeps
      // server.close()'s callback from ever firing.
      setTimeout(() => process.exit(0), 2000).unref();
    }
  }

  process.on('SIGINT', () => void handleShutdownSignal('SIGINT'));
  process.on('SIGTERM', () => void handleShutdownSignal('SIGTERM'));
}

// Only actually boot the server when this file is run directly (`npm run
// serve` / `tsx src/web/serve.ts`), not when a test imports it to exercise
// the pure resolve*()/parseArgs() helpers above -- otherwise every test run
// would try to bind a real socket and register real SIGINT/SIGTERM handlers.
const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
