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
import * as crypto from 'node:crypto';
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
import { authenticate, hasPlayers, playerSavesDir, touchLastSeen } from '../game/players';

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

/**
 * Single-use, short-lived tickets that let EventSource authenticate without
 * putting the real credential in a URL.
 *
 * The browser's EventSource cannot set request headers, so /api/events
 * historically took `?pin=<credential>`. Query strings are the one place a
 * secret reliably leaks by accident: they land in reverse-proxy access logs
 * (one `log` directive in a Caddyfile away), in tunnel/CDN logs, in browser
 * history, and in Referer headers. A PIN there was already unlovely; a
 * long-lived per-player access code there is worse, because it never rotates on
 * its own.
 *
 * So the client POSTs /api/sse-ticket with its normal credential header, gets a
 * one-shot opaque ticket, and spends it on the EventSource URL. A leaked ticket
 * is worth nothing: it is deleted on first use and expires in seconds.
 */
const SSE_TICKET_TTL_MS = 30_000;

class SseTicketStore {
  private readonly tickets = new Map<string, { playerId: string; expiresAt: number }>();

  issue(playerId: string): string {
    this.sweep();
    const ticket = crypto.randomBytes(24).toString('hex');
    this.tickets.set(ticket, { playerId, expiresAt: Date.now() + SSE_TICKET_TTL_MS });
    return ticket;
  }

  /** Returns the playerId and burns the ticket, or undefined if unknown/expired. */
  redeem(ticket: string | undefined): string | undefined {
    if (!ticket) return undefined;
    const record = this.tickets.get(ticket);
    if (!record) return undefined;
    this.tickets.delete(ticket);
    return Date.now() < record.expiresAt ? record.playerId : undefined;
  }

  /** Bounded memory without a timer: expired entries are dropped whenever a new one is issued. */
  private sweep(): void {
    const now = Date.now();
    for (const [ticket, record] of this.tickets) {
      if (now >= record.expiresAt) this.tickets.delete(ticket);
    }
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

/**
 * The whole client is this one file, so it MUST NOT be heuristically cached.
 * It previously went out with no cache headers at all, which lets a browser
 * reuse a stale copy for as long as it likes -- and it did: after the access-code
 * login shipped, a phone kept rendering the old numbers-only PIN field and no
 * valid code could be typed into it. There is no build hash to bust here, so
 * `no-cache` (revalidate every time) plus an ETag off the file's own size+mtime
 * gives correctness without re-sending 240KB on every load: unchanged file, 304.
 */
function serveIndexHtml(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const stat = fs.statSync(INDEX_HTML_PATH);
    const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: etag };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(fs.readFileSync(INDEX_HTML_PATH, 'utf8'));
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
  const sseTickets = new SseTicketStore();

  /**
   * The effective saves root. saves.ts defaults an undefined baseDir to
   * cwd/saves internally, but the player registry and per-player directories
   * need a concrete path to join, so resolve it once here with the same rule.
   */
  const savesRoot = baseDir ?? path.join(process.cwd(), 'saves');

  /** Session key used when no players are registered -- see resolveIdentity(). */
  const SOLO_SESSION_ID = '__solo__';

  /**
   * One player's live game. Everything that used to be a module-scope singleton
   * (bridge/controller/activeState) lives here instead, so two players can play
   * at once without seeing each other: `bridge` owns its OWN set of SSE sinks,
   * so a broadcast reaches only the clients subscribed to that player's stream.
   */
  interface Session {
    playerId: string;
    /** saves.ts `baseDir` scoped to this player -- the whole isolation mechanism. */
    saveDir: string;
    bridge: GameBridge;
    controller?: GameControllerLike;
    activeState?: GameState;
  }

  const sessions = new Map<string, Session>();

  function sessionFor(playerId: string, saveDir: string): Session {
    let session = sessions.get(playerId);
    if (!session) {
      session = { playerId, saveDir, bridge: new GameBridge() };
      sessions.set(playerId, session);
    }
    return session;
  }

  // Created up front so GameServerHandle.bridge is a stable reference in
  // single-player mode (serve.ts and the existing tests hold onto it).
  const soloSession = sessionFor(SOLO_SESSION_ID, savesRoot);

  function handleSlashCommand(session: Session, raw: string): void {
    const { bridge, activeState, controller } = session;
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

  async function handleContinue(session: Session, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Per-session now: another player having a game open is none of this
    // player's business, so only their OWN active session blocks them.
    if (session.bridge.hasSession) {
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
      // session.saveDir, not baseDir: a slug that exists for another player
      // simply isn't found here, which is what makes saves private.
      state = loadGame(slug, session.saveDir);
    } catch {
      respondJson(res, 404, { error: `campaign "${slug}" not found` });
      return;
    }
    session.activeState = state;
    const cb = session.bridge.attach({ slug: state.campaign.slug, name: state.campaign.name });
    session.controller = controllerFactory(state, cb, { baseDir: session.saveDir, debug });
    session.controller.start('resume');
    // Re-snapshots every already-connected client (e.g. another tab/device
    // sitting on the campaigns screen) onto this session -- see bridge.ts's
    // broadcastHello doc comment.
    session.bridge.broadcastHello();
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
  async function handleNew(session: Session, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (session.bridge.hasSession) {
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
        session.saveDir,
      );
    } catch (err) {
      respondJson(res, 400, { error: err instanceof Error ? err.message : 'invalid campaign input' });
      return;
    }

    saveGame(state, session.saveDir);
    session.activeState = state;
    const cb = session.bridge.attach({ slug: state.campaign.slug, name: state.campaign.name });
    session.controller = controllerFactory(state, cb, { baseDir: session.saveDir, debug });
    session.controller.start('new');
    session.bridge.broadcastHello();
    respondJson(res, 200, {});
  }

  /**
   * POST /api/retire -- this is web's `/retire`: replace the currently active
   * session's hero with a fresh one in the same persistent world. Requires an
   * active session (the wizard-completion logic Wizard.tsx's mode:'retire'
   * confirm step already runs for the TUI -- createNewHero + saveGame + the
   * "A new hero rises" transcript note -- reused here verbatim).
   */
  async function handleRetire(session: Session, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!session.controller || !session.activeState) {
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
      newState = createNewHero(session.activeState, { heroName, classId, race, backgroundId, statValues, stats: statsFromOrdered(statValues) });
    } catch (err) {
      respondJson(res, 400, { error: err instanceof Error ? err.message : 'invalid hero input' });
      return;
    }

    saveGame(newState, session.saveDir);
    const classPreset = CLASS_PRESETS.find((p) => p.id === classId);
    appendTranscript(
      newState.campaign.slug,
      {
        role: 'system',
        text: `A new hero rises: ${heroName} the ${race} ${classPreset?.name ?? classId}.`,
        ts: new Date().toISOString(),
      },
      session.saveDir,
    );

    // Shut the OLD controller down cleanly before swapping the new one in --
    // mirrors /api/end's controller.shutdown(), just without bridge.detach()
    // (bridge.attach() below resets all mirrored state itself, and skipping
    // detach() avoids a window where hasSession would flicker false).
    await session.controller.shutdown();

    session.activeState = newState;
    const cb = session.bridge.attach({ slug: newState.campaign.slug, name: newState.campaign.name });
    session.controller = controllerFactory(newState, cb, { baseDir: session.saveDir, debug });
    session.controller.start('new-hero');
    session.bridge.broadcastHello();
    respondJson(res, 200, {});
  }

  async function handleAction(session: Session, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!session.controller) {
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
      handleSlashCommand(session, trimmed);
    } else {
      session.controller.submitPlayerAction(trimmed);
    }
    respondJson(res, 200, {});
  }

  function handleRollConfirm(session: Session, res: http.ServerResponse): void {
    if (!session.controller) {
      respondJson(res, 400, { error: 'no active session' });
      return;
    }
    const reveal = session.controller.confirmRoll() ?? null;
    respondJson(res, 200, { reveal });
  }

  async function handleRollResolve(session: Session, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!session.controller) {
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
    const reveal = session.controller.resolvePendingRoll(body.useLuck === true) ?? null;
    respondJson(res, 200, { reveal });
  }

  async function handleInterrupt(session: Session, res: http.ServerResponse): Promise<void> {
    if (!session.controller) {
      respondJson(res, 400, { error: 'no active session' });
      return;
    }
    await session.controller.interrupt();
    respondJson(res, 200, {});
  }

  async function handleEnd(session: Session, res: http.ServerResponse): Promise<void> {
    if (session.controller) {
      await session.controller.shutdown();
    }
    session.controller = undefined;
    session.activeState = undefined;
    session.bridge.detach();
    respondJson(res, 200, {});
  }

  function handleEvents(session: Session, req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');

    const send: SseSink = (evt) => {
      res.write(`event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`);
    };
    // Subscribed to THIS player's bridge only. Each GameBridge owns its own
    // sink set, so a broadcast can never reach another player's stream -- which
    // is what stops one player's narration leaking into someone else's tab.
    send({ event: 'hello', data: session.bridge.hello() });
    const unsubscribe = session.bridge.subscribe(send);

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
          serveIndexHtml(req, res);
          return;
        }

        // Browsers request this unprompted; without the carve-out every page
        // load logs a spurious 401. Nothing sensitive: 204, no body.
        if (pathname === '/favicon.ico') {
          res.writeHead(204);
          res.end();
          return;
        }

        // Unauthenticated on purpose, and has to be: the login screen needs to
        // know what to ask for BEFORE it can ask for it. A 6-digit numeric PIN
        // field cannot accept a 29-character access code, so the client sizes
        // and labels its one input from this. It reveals only whether any
        // player is registered -- no names, no ids, no hashes.
        if (pathname === '/api/auth-mode' && method === 'GET') {
          respondJson(res, 200, { mode: hasPlayers(savesRoot) ? 'code' : 'pin' });
          return;
        }

        // Multi-player as soon as the registry has anyone in it (see
        // scripts/admin/players.ts). Read per-request rather than cached at boot so
        // adding the first player doesn't need a restart to take effect.
        const multiPlayer = hasPlayers(savesRoot);
        const ip = clientIp(req);

        // /api/events authenticates with a single-use ticket instead of the real
        // credential, so no long-lived secret ever appears in a URL. See
        // SseTicketStore. `?pin=` is still accepted as a fallback purely so an
        // already-open tab from a previous build keeps streaming until reload.
        if (pathname === '/api/events' && method === 'GET') {
          const ticketPlayer = sseTickets.redeem(url.searchParams.get('ticket') ?? undefined);
          if (ticketPlayer !== undefined) {
            const session =
              ticketPlayer === SOLO_SESSION_ID
                ? soloSession
                : sessionFor(ticketPlayer, playerSavesDir(savesRoot, ticketPlayer));
            handleEvents(session, req, res);
            return;
          }
        }

        // One header/param serves both modes: the value is the shared PIN when
        // no players are registered, and that player's access code once they are.
        const credential =
          pathname === '/api/events' ? (url.searchParams.get('pin') ?? undefined) : headerPin(req);

        let session: Session;
        if (multiPlayer) {
          // The access code is now the only credential; GAME_PIN is ignored,
          // because a per-player secret is strictly stronger than a shared one.
          if (pinRateLimiter.isLockedOut(ip)) {
            respondJson(res, 429, { error: 'too many failed attempts -- try again in a minute' });
            return;
          }
          const player = authenticate(savesRoot, credential);
          if (!player) {
            pinRateLimiter.recordFailure(ip);
            respondJson(res, 401, { error: 'invalid or missing access code' });
            return;
          }
          pinRateLimiter.recordSuccess(ip);
          session = sessionFor(player.id, playerSavesDir(savesRoot, player.id));
          touchLastSeen(savesRoot, player.id);
        } else {
          // Legacy single-player mode, unchanged: shared PIN, one session.
          // --no-pin mode has no PIN to brute-force, so the limiter is never
          // even consulted -- checkPin(_, undefined) always succeeds anyway.
          if (pin !== undefined) {
            if (pinRateLimiter.isLockedOut(ip)) {
              respondJson(res, 429, { error: 'too many failed PIN attempts -- try again in a minute' });
              return;
            }
            if (!checkPin(credential, pin)) {
              pinRateLimiter.recordFailure(ip);
              respondJson(res, 401, { error: 'invalid or missing PIN' });
              return;
            }
            pinRateLimiter.recordSuccess(ip);
          }
          session = soloSession;
        }

        if (pathname === '/api/events' && method === 'GET') {
          handleEvents(session, req, res);
          return;
        }
        if (pathname === '/api/sse-ticket' && method === 'POST') {
          respondJson(res, 200, { ticket: sseTickets.issue(session.playerId) });
          return;
        }
        if (pathname === '/api/campaigns' && method === 'GET') {
          respondJson(res, 200, listCampaigns(session.saveDir));
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
          await handleContinue(session, req, res);
          return;
        }
        if (pathname === '/api/new' && method === 'POST') {
          await handleNew(session, req, res);
          return;
        }
        if (pathname === '/api/retire' && method === 'POST') {
          await handleRetire(session, req, res);
          return;
        }
        if (pathname === '/api/action' && method === 'POST') {
          await handleAction(session, req, res);
          return;
        }
        if (pathname === '/api/roll/confirm' && method === 'POST') {
          handleRollConfirm(session, res);
          return;
        }
        if (pathname === '/api/roll/resolve' && method === 'POST') {
          await handleRollResolve(session, req, res);
          return;
        }
        if (pathname === '/api/interrupt' && method === 'POST') {
          await handleInterrupt(session, res);
          return;
        }
        if (pathname === '/api/end' && method === 'POST') {
          await handleEnd(session, res);
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
    bridge: soloSession.bridge,
    // Every live session, not just one: with per-player sessions a SIGTERM has
    // to give each player's controller its chance to autosave, or whoever
    // wasn't the "active" one silently loses their last turn.
    shutdown: async () => {
      await Promise.all(
        [...sessions.values()].map(async (session) => {
          if (!session.controller) return;
          await session.controller.shutdown();
          session.controller = undefined;
          session.activeState = undefined;
          session.bridge.detach();
        }),
      );
    },
  };
}
