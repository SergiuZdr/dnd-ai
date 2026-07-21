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
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { createGameServer } from './server';

const DEFAULT_PORT = 3123;
const DEFAULT_HOST = '0.0.0.0';

interface CliArgs {
  port: number;
  host: string;
  noPin: boolean;
  debug: boolean;
}

function parseArgs(argv: string[]): CliArgs {
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

function printStartupBox(urls: string[], port: number, pin: string | undefined): void {
  const lines = [
    'AI Dungeon Master -- phone/web mode',
    '',
    ...(urls.length > 0 ? urls : [`http://localhost:${port} (no LAN interface detected)`]),
    '',
    pin ? `PIN: ${pin}` : 'PIN disabled (--no-pin) -- anyone who can reach this port can play.',
  ];
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const border = '─'.repeat(width);
  console.log(`┌${border}┐`);
  for (const line of lines) {
    console.log(`│ ${line.padEnd(width - 2)} │`);
  }
  console.log(`└${border}┘`);
}

const args = parseArgs(process.argv.slice(2));
const pin = args.noPin ? undefined : generatePin();

const { server, shutdown } = createGameServer({ pin, debug: args.debug });

server.listen(args.port, args.host, () => {
  printStartupBox(lanUrls(args.port), args.port, pin);
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
