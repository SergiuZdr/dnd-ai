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
import type { GameState, Stats } from '../game/state';
import { GameController } from '../game/controller';
import type { ControllerCallbacks, GameControllerOptions, RollRevealResult } from '../game/controller';
import { loadGame, listCampaigns, saveGame, appendTranscript } from '../game/saves';
import {
  CLASS_PRESETS,
  RACES,
  BACKGROUNDS,
  THEMES,
  STANDARD_ARRAY,
  createNewCampaign,
  createNewHero,
  roll4d6DropLowest,
} from '../game/newCampaign';
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
/** Consecutive wrong-PIN attempts from one IP before that IP gets locked out -- see rateLimitPin() below. A tunnel (Tailscale/cloudflared) puts this endpoint on a network an attacker could reach, so brute force needs to actually cost something. */
const DEFAULT_PIN_MAX_ATTEMPTS = 5;
/** How long a locked-out IP gets 429'd before its counter resets, in ms. */
const DEFAULT_PIN_LOCKOUT_MS = 60_000;

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
  /** Consecutive wrong-PIN attempts from one IP before it's locked out. Defaults to 5. No-op when `pin` is undefined. Test seam -- see PinRateLimiter. */
  pinMaxAttempts?: number;
  /** Lockout duration in ms once pinMaxAttempts is hit. Defaults to 60_000. Test seam -- see PinRateLimiter. */
  pinLockoutMs?: number;
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

/** The IP a request came in on -- the key PIN brute-force tracking buckets by. */
function clientIp(req: http.IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

interface PinAttemptRecord {
  failures: number;
  /** epoch ms this IP's lockout ends; 0 means not currently locked out. */
  lockedUntil: number;
}

/**
 * Per-IP consecutive-failed-PIN tracker, in-memory and dependency-free (a
 * Map, not a rate-limiting library -- this process is the only place state
 * needs to live, and it's fine to lose the table on restart). Exists
 * because a tunnel (Tailscale is private, but the Cloudflare quick-tunnel
 * option in scripts/tunnel.ts is a public URL) puts /api/* on a network an
 * attacker could reach and script a brute force against; --no-pin mode has
 * no PIN to brute-force so it's never even consulted (see the `pin !==
 * undefined` guard at the call site).
 *
 * Test seam: maxAttempts/lockoutMs are constructor params (defaulted from
 * GameServerOptions) rather than the module constants directly, so tests
 * can use small counts/short cooldowns instead of waiting on the real
 * 5-attempts/60-second defaults.
 */
class PinRateLimiter {
  private readonly attempts = new Map<string, PinAttemptRecord>();

  constructor(
    private readonly maxAttempts: number,
    private readonly lockoutMs: number,
  ) {}

  /** True if this IP is currently locked out. Clears an expired lockout as a side effect, so a stale entry doesn't linger forever. */
  isLockedOut(ip: string): boolean {
    const record = this.attempts.get(ip);
    if (!record || record.lockedUntil === 0) return false;
    if (Date.now() >= record.lockedUntil) {
      this.attempts.delete(ip);
      return false;
    }
    return true;
  }

  /** Call after a failed PIN check; locks the IP out once it hits maxAttempts consecutive failures. */
  recordFailure(ip: string): void {
    const record = this.attempts.get(ip) ?? { failures: 0, lockedUntil: 0 };
    record.failures += 1;
    if (record.failures >= this.maxAttempts) {
      record.lockedUntil = Date.now() + this.lockoutMs;
    }
    this.attempts.set(ip, record);
  }

  /** Call after a successful PIN check; wipes the slate for that IP. */
  recordSuccess(ip: string): void {
    this.attempts.delete(ip);
  }
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

/** `body.statValues` must be a 6-element array of finite numbers to be a valid ability-score set; anything else (missing, wrong length, non-numbers) is rejected wholesale rather than partially accepted. */
function parseStatValues(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length !== 6) return undefined;
  return value.every((v) => typeof v === 'number' && Number.isFinite(v)) ? (value as number[]) : undefined;
}

/**
 * The web wizard sends `statValues` already in the player's chosen per-ability
 * order — [STR, DEX, CON, INT, WIS, CHA] — so we pass an explicit `stats`
 * object through to createNew*, honoring their assignment verbatim instead of
 * letting buildCharacter auto-sort the pool by class priority. (buildCharacter
 * still applies race bonuses on top of these base scores.)
 */
function statsFromOrdered(values: number[]): Stats {
  return { str: values[0], dex: values[1], con: values[2], int: values[3], wis: values[4], cha: values[5] };
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
  const pinRateLimiter = new PinRateLimiter(
    opts.pinMaxAttempts ?? DEFAULT_PIN_MAX_ATTEMPTS,
    opts.pinLockoutMs ?? DEFAULT_PIN_LOCKOUT_MS,
  );

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
    // Re-snapshots every already-connected client (e.g. another tab/device
    // sitting on the campaigns screen) onto this session -- see bridge.ts's
    // broadcastHello doc comment.
    bridge.broadcastHello();
    respondJson(res, 200, {});
  }

  /** GET /api/presets -- the catalogs the web wizard renders from, so classes/races/backgrounds/themes live in exactly one place (newCampaign.ts). */
  function handlePresets(res: http.ServerResponse): void {
    respondJson(res, 200, {
      classes: CLASS_PRESETS.map((preset) => ({
        id: preset.id,
        name: preset.name,
        tagline: preset.tagline,
        hitBase: preset.hitBase,
        keyStat: preset.statPriority[0].toUpperCase(),
        kit: preset.starterItems.map((item) => (item.qty > 1 ? `${item.name} ×${item.qty}` : item.name)),
      })),
      races: RACES.map((r) => ({ id: r.id, name: r.name, description: r.description })),
      backgrounds: BACKGROUNDS.map((b) => ({ id: b.id, name: b.name, description: b.description })),
      themes: THEMES.map((t) => ({ id: t.id, label: t.label, seed: t.seed })),
      standardArray: STANDARD_ARRAY,
    });
  }

  /** POST /api/roll-stats -- six server-authoritative roll4d6DropLowest() values; the client may call this repeatedly to reroll. */
  function handleRollStats(res: http.ServerResponse): void {
    const values = Array.from({ length: 6 }, () => roll4d6DropLowest());
    respondJson(res, 200, { values });
  }

  /** POST /api/new -- create + start a brand-new campaign. Requires no active session (client calls /api/end first). */
  async function handleNew(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const heroName = typeof body.heroName === 'string' ? body.heroName.trim() : '';
    const classId = typeof body.classId === 'string' ? body.classId : '';
    const race = typeof body.race === 'string' ? body.race : '';
    const backgroundId = typeof body.backgroundId === 'string' ? body.backgroundId : undefined;
    const statValues = parseStatValues(body.statValues);
    const themeSeed = typeof body.themeSeed === 'string' ? body.themeSeed.trim() : '';
    const contentRating =
      body.contentRating === 'PG-13' || body.contentRating === 'R' ? body.contentRating : undefined;

    if (!name || !heroName || !classId || !race || !statValues || !themeSeed) {
      respondJson(res, 400, { error: 'missing or invalid fields' });
      return;
    }

    let state: GameState;
    try {
      state = createNewCampaign(
        { name, heroName, classId, race, backgroundId, statValues, stats: statsFromOrdered(statValues), themeSeed, contentRating },
        baseDir,
      );
    } catch (err) {
      respondJson(res, 400, { error: err instanceof Error ? err.message : 'invalid campaign input' });
      return;
    }

    saveGame(state, baseDir);
    activeState = state;
    const cb = bridge.attach({ slug: state.campaign.slug, name: state.campaign.name });
    controller = controllerFactory(state, cb, { baseDir, debug });
    controller.start('new');
    bridge.broadcastHello();
    respondJson(res, 200, {});
  }

  /**
   * POST /api/retire -- this is web's `/retire`: replace the currently active
   * session's hero with a fresh one in the same persistent world. Requires an
   * active session (the wizard-completion logic Wizard.tsx's mode:'retire'
   * confirm step already runs for the TUI -- createNewHero + saveGame + the
   * "A new hero rises" transcript note -- reused here verbatim).
   */
  async function handleRetire(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!controller || !activeState) {
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

    const heroName = typeof body.heroName === 'string' ? body.heroName.trim() : '';
    const classId = typeof body.classId === 'string' ? body.classId : '';
    const race = typeof body.race === 'string' ? body.race : '';
    const backgroundId = typeof body.backgroundId === 'string' ? body.backgroundId : undefined;
    const statValues = parseStatValues(body.statValues);

    if (!heroName || !classId || !race || !statValues) {
      respondJson(res, 400, { error: 'missing or invalid fields' });
      return;
    }

    let newState: GameState;
    try {
      newState = createNewHero(activeState, { heroName, classId, race, backgroundId, statValues, stats: statsFromOrdered(statValues) });
    } catch (err) {
      respondJson(res, 400, { error: err instanceof Error ? err.message : 'invalid hero input' });
      return;
    }

    saveGame(newState, baseDir);
    const classPreset = CLASS_PRESETS.find((p) => p.id === classId);
    appendTranscript(
      newState.campaign.slug,
      {
        role: 'system',
        text: `A new hero rises: ${heroName} the ${race} ${classPreset?.name ?? classId}.`,
        ts: new Date().toISOString(),
      },
      baseDir,
    );

    // Shut the OLD controller down cleanly before swapping the new one in --
    // mirrors /api/end's controller.shutdown(), just without bridge.detach()
    // (bridge.attach() below resets all mirrored state itself, and skipping
    // detach() avoids a window where hasSession would flicker false).
    await controller.shutdown();

    activeState = newState;
    const cb = bridge.attach({ slug: newState.campaign.slug, name: newState.campaign.name });
    controller = controllerFactory(newState, cb, { baseDir, debug });
    controller.start('new-hero');
    bridge.broadcastHello();
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

        // Browsers request this unprompted; without the carve-out every page
        // load logs a spurious 401. Nothing sensitive: 204, no body.
        if (pathname === '/favicon.ico') {
          res.writeHead(204);
          res.end();
          return;
        }

        // Every route below is gated -- SSE can't set headers, so it takes
        // the pin as a query param instead of the X-Game-Pin header.
        const providedPin = pathname === '/api/events' ? (url.searchParams.get('pin') ?? undefined) : headerPin(req);
        // --no-pin mode has no PIN to brute-force, so the limiter is never
        // even consulted -- checkPin(_, undefined) always succeeds anyway.
        if (pin !== undefined) {
          const ip = clientIp(req);
          if (pinRateLimiter.isLockedOut(ip)) {
            respondJson(res, 429, { error: 'too many failed PIN attempts -- try again in a minute' });
            return;
          }
          if (!checkPin(providedPin, pin)) {
            pinRateLimiter.recordFailure(ip);
            respondJson(res, 401, { error: 'invalid or missing PIN' });
            return;
          }
          pinRateLimiter.recordSuccess(ip);
        }

        if (pathname === '/api/events' && method === 'GET') {
          handleEvents(req, res);
          return;
        }
        if (pathname === '/api/campaigns' && method === 'GET') {
          respondJson(res, 200, listCampaigns(baseDir));
          return;
        }
        if (pathname === '/api/presets' && method === 'GET') {
          handlePresets(res);
          return;
        }
        if (pathname === '/api/roll-stats' && method === 'POST') {
          handleRollStats(res);
          return;
        }
        if (pathname === '/api/continue' && method === 'POST') {
          await handleContinue(req, res);
          return;
        }
        if (pathname === '/api/new' && method === 'POST') {
          await handleNew(req, res);
          return;
        }
        if (pathname === '/api/retire' && method === 'POST') {
          await handleRetire(req, res);
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
