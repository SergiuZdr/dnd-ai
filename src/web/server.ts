// The phone/web HTTP server: a thin, framework-free layer (Node's `http`
// only -- see the file header philosophy in serve.ts for why no `ws`/no
// bundler) that reuses GameController completely unmodified. Every route
// below either reads pure data (saves.ts) or calls a GameController method
// that already exists for the TUI; GameBridge (bridge.ts) is the only new
// piece of "brain," and it's UI-free too. This file owns the HTTP contract:
// PIN gate, JSON parsing/responses, SSE wiring, and the one active session's
// lifecycle (continue/action/roll/interrupt/end).
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameState } from '../game/state';
import { GameController } from '../game/controller';
import type { ControllerCallbacks, GameControllerOptions, RollRevealResult } from '../game/controller';
import { loadGame, listCampaigns } from '../game/saves';
import {
  formatHelpWeb,
  formatCharacterSheet,
  formatJournal,
  unknownCommandNote,
} from '../ui/slashCommands';
import { GameBridge } from './bridge';
import type { SseSink } from './bridge';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');
const HEARTBEAT_MS = 25_000;
const PIN_HEADER = 'x-game-pin';

/**
 * The minimal surface server.ts needs from a GameController -- mirrors how
 * controller.ts's own DmSessionLike/sessionFactory seam works, so tests can
 * inject a fake here instead of ever constructing a real GameController
 * (which would try to spawn a DmSession the moment start() is called).
 */
export interface GameControllerLike {
  start(mode: 'new' | 'resume' | 'new-hero'): void;
  submitPlayerAction(text: string): void;
  confirmRoll(): RollRevealResult | undefined;
  resolvePendingRoll(useLuck: boolean): RollRevealResult | undefined;
  interrupt(): Promise<void>;
  shutdown(): Promise<void>;
  forceSave(): void;
}

export interface GameServerOptions {
  /** Same override point GameController/saves.ts use -- tests point this at a tmpdir. Defaults to saves/ under cwd. */
  baseDir?: string;
  /** Test seam: replaces `new GameController(...)`. Defaults to constructing a real one. */
  controllerFactory?: (
    state: GameState,
    cb: ControllerCallbacks,
    opts?: GameControllerOptions,
  ) => GameControllerLike;
  /** Required on every route except GET / and GET /api/campaigns's own 401 path. undefined -- no PIN check (--no-pin). */
  pin?: string;
  /** Passed through to GameController's debug option. */
  debug?: boolean;
}

export interface GameServerHandle {
  server: http.Server;
  bridge: GameBridge;
  /** Ends the active session's controller (if any) cleanly -- serve.ts calls this on SIGINT/SIGTERM. Idempotent. */
  shutdown: () => Promise<void>;
}

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

function headerPin(req: http.IncomingMessage): string | undefined {
  const raw = req.headers[PIN_HEADER];
  return Array.isArray(raw) ? raw[0] : raw;
}

function checkPin(provided: string | undefined, expected: string | undefined): boolean {
  if (expected === undefined) return true; // --no-pin
  return provided === expected;
}

/** Collects and JSON-parses a request body; '' body -> {} (routes with no required fields still work). */
function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer | string) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (raw.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        resolve(typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function serveIndexHtml(res: http.ServerResponse): void {
  try {
    const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    respondJson(res, 500, { error: 'index.html missing' });
  }
}

export function createGameServer(opts: GameServerOptions = {}): GameServerHandle {
  const baseDir = opts.baseDir;
  const pin = opts.pin;
  const debug = opts.debug ?? false;
  const controllerFactory =
    opts.controllerFactory ??
    ((state: GameState, cb: ControllerCallbacks, controllerOpts?: GameControllerOptions) =>
      new GameController(state, cb, controllerOpts));

  const bridge = new GameBridge();
  let controller: GameControllerLike | undefined;
  let activeState: GameState | undefined;

  function handleSlashCommand(raw: string): void {
    const command = raw.trim().toLowerCase();
    switch (command) {
      case '/help':
        bridge.appendSystemEntry(formatHelpWeb());
        return;
      case '/sheet':
        if (activeState) bridge.appendSystemEntry(formatCharacterSheet(activeState));
        return;
      case '/journal':
        if (activeState) bridge.appendSystemEntry(formatJournal(activeState.chronicle));
        return;
      case '/save':
        controller?.forceSave();
        bridge.appendSystemEntry('Saved.');
        return;
      case '/retire':
        bridge.appendSystemEntry(
          '/retire is TUI-only for now — run `npm run play` in a terminal to retire your hero and raise a new one.',
        );
        return;
      case '/quit':
        bridge.appendSystemEntry(
          "/quit isn't needed on web — your progress is already saved after every turn. Just close this tab, or tap End Session.",
        );
        return;
      default:
        bridge.appendSystemEntry(unknownCommandNote(raw.trim()));
    }
  }

  async function handleContinue(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (bridge.hasSession) {
      respondJson(res, 409, { error: 'session already running' });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      respondJson(res, 400, { error: 'invalid JSON body' });
      return;
    }
    const slug = typeof body.slug === 'string' ? body.slug : undefined;
    if (!slug) {
      respondJson(res, 400, { error: 'missing slug' });
      return;
    }
    let state: GameState;
    try {
      state = loadGame(slug, baseDir);
    } catch {
      respondJson(res, 404, { error: `campaign "${slug}" not found` });
      return;
    }
    activeState = state;
    const cb = bridge.attach({ slug: state.campaign.slug, name: state.campaign.name });
    controller = controllerFactory(state, cb, { baseDir, debug });
    controller.start('resume');
    respondJson(res, 200, {});
  }

  async function handleAction(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!controller) {
      respondJson(res, 400, { error: 'no active session' });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      respondJson(res, 400, { error: 'invalid JSON body' });
      return;
    }
    const text = typeof body.text === 'string' ? body.text : '';
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      respondJson(res, 200, {});
      return;
    }
    if (trimmed.startsWith('/')) {
      handleSlashCommand(trimmed);
    } else {
      controller.submitPlayerAction(trimmed);
    }
    respondJson(res, 200, {});
  }

  function handleRollConfirm(res: http.ServerResponse): void {
    if (!controller) {
      respondJson(res, 400, { error: 'no active session' });
      return;
    }
    const reveal = controller.confirmRoll() ?? null;
    respondJson(res, 200, { reveal });
  }

  async function handleRollResolve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!controller) {
      respondJson(res, 400, { error: 'no active session' });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      respondJson(res, 400, { error: 'invalid JSON body' });
      return;
    }
    const reveal = controller.resolvePendingRoll(body.useLuck === true) ?? null;
    respondJson(res, 200, { reveal });
  }

  async function handleInterrupt(res: http.ServerResponse): Promise<void> {
    if (!controller) {
      respondJson(res, 400, { error: 'no active session' });
      return;
    }
    await controller.interrupt();
    respondJson(res, 200, {});
  }

  async function handleEnd(res: http.ServerResponse): Promise<void> {
    if (controller) {
      await controller.shutdown();
    }
    controller = undefined;
    activeState = undefined;
    bridge.detach();
    respondJson(res, 200, {});
  }

  function handleEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');

    const send: SseSink = (evt) => {
      res.write(`event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`);
    };
    send({ event: 'hello', data: bridge.hello() });
    const unsubscribe = bridge.subscribe(send);

    // Keeps phone carriers'/routers' idle-connection timeouts from silently
    // dropping the stream; unref'd so it never by itself keeps the process
    // (or a test) alive after everything else has shut down.
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, HEARTBEAT_MS);
    heartbeat.unref();

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }

  const requestListener: http.RequestListener = (req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const pathname = url.pathname;
        const method = req.method ?? 'GET';

        if (pathname === '/' && method === 'GET') {
          serveIndexHtml(res);
          return;
        }

        // Every route below is gated -- SSE can't set headers, so it takes
        // the pin as a query param instead of the X-Game-Pin header.
        const providedPin = pathname === '/api/events' ? (url.searchParams.get('pin') ?? undefined) : headerPin(req);
        if (!checkPin(providedPin, pin)) {
          respondJson(res, 401, { error: 'invalid or missing PIN' });
          return;
        }

        if (pathname === '/api/events' && method === 'GET') {
          handleEvents(req, res);
          return;
        }
        if (pathname === '/api/campaigns' && method === 'GET') {
          respondJson(res, 200, listCampaigns(baseDir));
          return;
        }
        if (pathname === '/api/continue' && method === 'POST') {
          await handleContinue(req, res);
          return;
        }
        if (pathname === '/api/action' && method === 'POST') {
          await handleAction(req, res);
          return;
        }
        if (pathname === '/api/roll/confirm' && method === 'POST') {
          handleRollConfirm(res);
          return;
        }
        if (pathname === '/api/roll/resolve' && method === 'POST') {
          await handleRollResolve(req, res);
          return;
        }
        if (pathname === '/api/interrupt' && method === 'POST') {
          await handleInterrupt(res);
          return;
        }
        if (pathname === '/api/end' && method === 'POST') {
          await handleEnd(res);
          return;
        }

        respondJson(res, 404, { error: 'not found' });
      } catch {
        // Never leak stack traces -- a malformed request or unexpected
        // internal failure just gets a generic 500.
        if (!res.headersSent) respondJson(res, 500, { error: 'internal server error' });
      }
    })();
  };

  const server = http.createServer(requestListener);

  return {
    server,
    bridge,
    shutdown: async () => {
      if (controller) {
        await controller.shutdown();
        controller = undefined;
        activeState = undefined;
        bridge.detach();
      }
    },
  };
}
