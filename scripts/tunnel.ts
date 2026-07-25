// Convenience launcher for playing from anywhere, not just this Wi-Fi:
// `npm run serve:remote`. It starts the exact same game server serve.ts
// does (createGameServer() from src/web/server.ts) and, if the `cloudflared`
// CLI is on PATH, also opens a Cloudflare "quick tunnel"
// (`cloudflared tunnel --url http://localhost:<port>`) -- a free, no-account
// public HTTPS URL that forwards straight to this laptop. The printed
// https://*.trycloudflare.com address works from any network (cell data,
// a friend's Wi-Fi, anywhere), not just devices on this LAN.
//
// If cloudflared isn't installed, this falls back to exactly what
// `npm run serve` does -- local/LAN only -- and prints install instructions
// instead of silently doing less than asked. See README's "Play from your
// phone anywhere" section for the full walkthrough, and prefer Tailscale
// there if you'd rather never expose a public URL at all.
//
// Stdlib only (child_process, os, crypto) -- same no-new-dependency
// philosophy as serve.ts, just spawning a CLI instead of a WS/HTTP library.
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createGameServer } from '../src/web/server';

const DEFAULT_PORT = 3123;
const DEFAULT_HOST = '0.0.0.0';
/** cloudflared prints this on its own stdout/stderr once the tunnel is live; quick tunnels always land on *.trycloudflare.com. */
const CLOUDFLARED_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
/** How long to wait for cloudflared to hand back a URL before giving up on it for this run and just running local/LAN. */
const CLOUDFLARED_TIMEOUT_MS = 20_000;

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

/** All non-internal IPv4 addresses of this machine -- same LAN fallback serve.ts prints, still useful here (e.g. Tailscale shows up as one of these too). */
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

/** 6 digits, cryptographically random -- identical scheme to serve.ts's generatePin(). */
function generatePin(): string {
  return crypto.randomInt(100_000, 1_000_000).toString();
}

function printBox(lines: string[]): void {
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const border = '─'.repeat(width);
  console.log(`┌${border}┐`);
  for (const line of lines) {
    console.log(`│ ${line.padEnd(width - 2)} │`);
  }
  console.log(`└${border}┘`);
}

function pinLine(pin: string | undefined, sharedNote: string): string {
  return pin ? `PIN: ${pin}` : `PIN disabled (--no-pin) -- anyone who ${sharedNote} can play.`;
}

function printLocalOnlyBox(urls: string[], port: number, pin: string | undefined): void {
  printBox([
    'AI Dungeon Master -- phone/web mode (local network only)',
    '',
    ...(urls.length > 0 ? urls : [`http://localhost:${port} (no LAN interface detected)`]),
    '',
    pinLine(pin, 'can reach this port'),
  ]);
}

function printCloudflaredMissingHint(urls: string[], port: number, pin: string | undefined): void {
  printLocalOnlyBox(urls, port, pin);
  printBox([
    'No public URL: the `cloudflared` CLI was not found on PATH.',
    '',
    'Install it, then re-run `npm run serve:remote`:',
    '  macOS:    brew install cloudflared',
    '  Windows:  winget install --id Cloudflare.cloudflared',
    '  Linux:    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
    '',
    '(Meanwhile the LAN URL above still works on this Wi-Fi.)',
  ]);
}

function printRemoteBox(tunnelUrl: string, urls: string[], port: number, pin: string | undefined): void {
  const lanLines =
    urls.length > 0 ? urls.map((u) => `LAN:     ${u}`) : [`LAN:     http://localhost:${port} (no LAN interface detected)`];
  printBox([
    'AI Dungeon Master -- remote play (Cloudflare quick tunnel)',
    '',
    `PUBLIC:  ${tunnelUrl}`,
    ...lanLines,
    '',
    pinLine(pin, 'has this URL'),
    '',
    'This URL is public (anyone with it can reach this server) but unguessable',
    'and changes every run -- do not post it anywhere public. Prefer Tailscale',
    '(see README) if you want zero public exposure at all.',
  ]);
}

/** `cloudflared --version` succeeding (exit 0, no spawn error) is proof enough it's installed and runnable. */
function isCloudflaredInstalled(): boolean {
  const result = spawnSync('cloudflared', ['--version'], { stdio: 'ignore' });
  return result.error === undefined && result.status === 0;
}

function startCloudflaredTunnel(port: number): ChildProcessWithoutNullStreams {
  return spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`]);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pin = args.noPin ? undefined : generatePin();

  const { server, shutdown } = createGameServer({ pin, debug: args.debug });

  let cloudflaredProc: ChildProcessWithoutNullStreams | undefined;
  let shuttingDown = false;

  server.listen(args.port, args.host, () => {
    const urls = lanUrls(args.port);

    if (!isCloudflaredInstalled()) {
      printCloudflaredMissingHint(urls, args.port, pin);
      return;
    }

    console.log('Opening a Cloudflare quick tunnel (cloudflared tunnel --url ...)...');
    cloudflaredProc = startCloudflaredTunnel(args.port);
    let printed = false;

    const onOutput = (chunk: Buffer): void => {
      if (printed) return;
      const match = CLOUDFLARED_URL_RE.exec(chunk.toString());
      if (match) {
        printed = true;
        printRemoteBox(match[0], urls, args.port, pin);
      }
    };
    cloudflaredProc.stdout.on('data', onOutput);
    cloudflaredProc.stderr.on('data', onOutput);

    cloudflaredProc.on('error', (err) => {
      if (printed || shuttingDown) return;
      console.error(`[tunnel] failed to launch cloudflared: ${err.message}`);
      printCloudflaredMissingHint(urls, args.port, pin);
    });
    cloudflaredProc.on('exit', (code) => {
      if (printed || shuttingDown) return;
      console.error(`[tunnel] cloudflared exited before a URL appeared (code ${code}). Falling back to local/LAN only.`);
      printLocalOnlyBox(urls, args.port, pin);
    });

    setTimeout(() => {
      if (printed || shuttingDown) return;
      console.error('[tunnel] still waiting on cloudflared for a public URL -- the LAN address below works meanwhile:');
      printLocalOnlyBox(urls, args.port, pin);
    }, CLOUDFLARED_TIMEOUT_MS).unref();
  });

  async function handleShutdownSignal(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[${signal}] Saving and shutting down...`);
    if (cloudflaredProc && cloudflaredProc.exitCode === null && !cloudflaredProc.killed) {
      cloudflaredProc.kill();
    }
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

void main();
