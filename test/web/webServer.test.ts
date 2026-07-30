// HTTP-contract tests for the phone/web server: real http.Server on port 0,
// real fetch() against 127.0.0.1 (no mocked network), but a FAKE
// GameControllerLike injected via controllerFactory -- a real GameController
// would try to spawn a DmSession (the Agent SDK) the instant start() is
// called, which nothing in this suite may do.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createGameServer } from '../../src/web/server';
import type { GameServerHandle, GameControllerLike, GameServerOptions } from '../../src/web/server';
import type { GameState } from '../../src/game/state';
import type { ControllerCallbacks, RollRevealResult } from '../../src/game/controller';
import { saveGame, readTranscript } from '../../src/game/saves';

function makeState(slug: string, name: string): GameState {
  return {
    campaign: {
      slug,
      name,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      contentRating: 'PG-13',
    },
    character: {
      name: 'Hero',
      className: 'Fighter',
      race: 'Human',
      background: '',
      backgroundFact: '',
      level: 1,
      xp: 300,
      hp: 12,
      maxHp: 12,
      ac: 15,
      stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
      gold: 10,
      inventory: [{ name: 'Rope', qty: 1 }],
      luck: 1,
    },
    world: { theme: 'classic fantasy', location: 'Starting Village', npcs: [], quests: [], facts: [] },
    chronicle: { storySoFar: '', chapters: [], lastSummarizedIndex: 0 },
  };
}

class FakeController implements GameControllerLike {
  startedWith: 'new' | 'resume' | 'new-hero' | null = null;
  actions: string[] = [];
  interrupted = false;
  shutdownCalled = false;
  forceSaveCalled = false;
  confirmRollResult: RollRevealResult | undefined;
  resolveRollResult: RollRevealResult | undefined;
  lastResolveUseLuck: boolean | undefined;

  constructor(
    public readonly state: GameState,
    public readonly cb: ControllerCallbacks,
  ) {}

  start(mode: 'new' | 'resume' | 'new-hero'): void {
    this.startedWith = mode;
  }
  submitPlayerAction(text: string): void {
    this.actions.push(text);
  }
  confirmRoll(): RollRevealResult | undefined {
    return this.confirmRollResult;
  }
  resolvePendingRoll(useLuck: boolean): RollRevealResult | undefined {
    this.lastResolveUseLuck = useLuck;
    return this.resolveRollResult;
  }
  async interrupt(): Promise<void> {
    this.interrupted = true;
  }
  async shutdown(): Promise<void> {
    this.shutdownCalled = true;
  }
  forceSave(): void {
    this.forceSaveCalled = true;
  }
}

interface TestServer {
  baseUrl: string;
  handle: GameServerHandle;
  controllers: FakeController[];
  baseDir: string;
}

async function startTestServer(pin?: string, extra: Partial<GameServerOptions> = {}): Promise<TestServer> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-web-server-'));
  const controllers: FakeController[] = [];
  const handle = createGameServer({
    baseDir,
    pin,
    controllerFactory: (state, cb) => {
      const controller = new FakeController(state, cb);
      controllers.push(controller);
      return controller;
    },
    ...extra,
  });
  await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', () => resolve()));
  const port = (handle.server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, handle, controllers, baseDir };
}

async function stopTestServer(t: TestServer): Promise<void> {
  await new Promise<void>((resolve) => t.handle.server.close(() => resolve()));
  fs.rmSync(t.baseDir, { recursive: true, force: true });
}

const PIN = '123456';

describe('web server: PIN gate', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await startTestServer(PIN);
  });
  afterEach(async () => {
    await stopTestServer(t);
  });

  it('serves GET / with no PIN required', async () => {
    const res = await fetch(`${t.baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<html');
  });

  // Regression: served with no cache headers at all, a browser is free to reuse
  // index.html indefinitely -- and did, leaving a phone on the pre-access-code
  // login screen whose numeric field could not accept a valid code.
  it('tells the browser to revalidate index.html rather than reuse it blindly', async () => {
    const res = await fetch(`${t.baseUrl}/`);
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('etag')).toBeTruthy();
  });

  it('answers a matching If-None-Match with 304, so revalidation stays cheap', async () => {
    const first = await fetch(`${t.baseUrl}/`);
    const etag = first.headers.get('etag')!;
    await first.text();

    const second = await fetch(`${t.baseUrl}/`, { headers: { 'If-None-Match': etag } });
    expect(second.status).toBe(304);
    expect((await second.text()).length).toBe(0);
  });

  it('sends the full document when the ETag does not match', async () => {
    const res = await fetch(`${t.baseUrl}/`, { headers: { 'If-None-Match': 'W/"stale-etag"' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<html');
  });

  it('401s a data route with no X-Game-Pin header', async () => {
    const res = await fetch(`${t.baseUrl}/api/campaigns`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('401s a data route with the WRONG pin', async () => {
    const res = await fetch(`${t.baseUrl}/api/campaigns`, { headers: { 'X-Game-Pin': '000000' } });
    expect(res.status).toBe(401);
  });

  it('200s a data route with the correct pin header', async () => {
    const res = await fetch(`${t.baseUrl}/api/campaigns`, { headers: { 'X-Game-Pin': PIN } });
    expect(res.status).toBe(200);
  });

  it('accepts the pin as a query param on the SSE route specifically', async () => {
    const controller = new AbortController();
    const res = await fetch(`${t.baseUrl}/api/events?pin=${PIN}`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!buffer.includes('event: hello')) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
    }
    expect(buffer).toContain('event: hello');
    expect(buffer).toContain('"campaign":null');
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  it('401s the SSE route with a missing/wrong pin query param', async () => {
    const res = await fetch(`${t.baseUrl}/api/events?pin=wrong`);
    expect(res.status).toBe(401);
  });
});

describe('web server: --no-pin mode', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await startTestServer(undefined);
  });
  afterEach(async () => {
    await stopTestServer(t);
  });

  it('allows data routes through with no X-Game-Pin header at all', async () => {
    const res = await fetch(`${t.baseUrl}/api/campaigns`);
    expect(res.status).toBe(200);
  });
});

describe('web server: PIN brute-force lockout', () => {
  let t: TestServer;
  beforeEach(async () => {
    // Small maxAttempts/long-ish lockoutMs -- the lockout must still be in
    // effect by the time the test's follow-up assertions run, but 3 attempts
    // keeps the test itself fast.
    t = await startTestServer(PIN, { pinMaxAttempts: 3, pinLockoutMs: 60_000 });
  });
  afterEach(async () => {
    await stopTestServer(t);
  });

  it('locks the IP out after N consecutive failures, 429ing even a subsequently-correct PIN', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${t.baseUrl}/api/campaigns`, { headers: { 'X-Game-Pin': 'wrong' } });
      expect(res.status).toBe(401);
    }
    const lockedOutWrong = await fetch(`${t.baseUrl}/api/campaigns`, { headers: { 'X-Game-Pin': 'wrong' } });
    expect(lockedOutWrong.status).toBe(429);

    // Even the RIGHT pin is refused while locked out -- the lockout is
    // per-IP, not "did this exact request guess right."
    const lockedOutCorrect = await fetch(`${t.baseUrl}/api/campaigns`, { headers: { 'X-Game-Pin': PIN } });
    expect(lockedOutCorrect.status).toBe(429);
  });

  it('resets the failure counter on a successful auth, so it takes a fresh N failures to lock out again', async () => {
    // Two failures (one under the max of 3) -- not locked out yet.
    expect((await fetch(`${t.baseUrl}/api/campaigns`, { headers: { 'X-Game-Pin': 'wrong' } })).status).toBe(401);
    expect((await fetch(`${t.baseUrl}/api/campaigns`, { headers: { 'X-Game-Pin': 'wrong' } })).status).toBe(401);

    // A successful auth in between should wipe those two failures out.
    expect((await fetch(`${t.baseUrl}/api/campaigns`, { headers: { 'X-Game-Pin': PIN } })).status).toBe(200);

    // Two more failures post-reset still shouldn't trip the lockout (would
    // have been the 4th/5th consecutive failure if the counter hadn't reset).
    expect((await fetch(`${t.baseUrl}/api/campaigns`, { headers: { 'X-Game-Pin': 'wrong' } })).status).toBe(401);
    expect((await fetch(`${t.baseUrl}/api/campaigns`, { headers: { 'X-Game-Pin': 'wrong' } })).status).toBe(401);
    expect((await fetch(`${t.baseUrl}/api/campaigns`, { headers: { 'X-Game-Pin': PIN } })).status).toBe(200);
  });

  it('never rate-limits in --no-pin mode', async () => {
    const open = await startTestServer(undefined, { pinMaxAttempts: 1, pinLockoutMs: 60_000 });
    try {
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${open.baseUrl}/api/campaigns`);
        expect(res.status).toBe(200);
      }
    } finally {
      await stopTestServer(open);
    }
  });
});

describe('web server: campaigns listing', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await startTestServer(undefined);
    saveGame(makeState('camp-a', 'Campaign A'), t.baseDir);
    saveGame(makeState('camp-b', 'Campaign B'), t.baseDir);
  });
  afterEach(async () => {
    await stopTestServer(t);
  });

  it('lists saved campaigns (slug, name, updatedAt)', async () => {
    const res = await fetch(`${t.baseUrl}/api/campaigns`);
    const list = await res.json();
    expect(list.map((c: { slug: string }) => c.slug).sort()).toEqual(['camp-a', 'camp-b']);
    expect(list[0]).toHaveProperty('name');
    expect(list[0]).toHaveProperty('updatedAt');
  });
});

describe('web server: continue / session lifecycle', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await startTestServer(undefined);
    saveGame(makeState('camp-a', 'Campaign A'), t.baseDir);
  });
  afterEach(async () => {
    await stopTestServer(t);
  });

  it('constructs the controller with the loaded state and starts it in "resume" mode', async () => {
    const res = await fetch(`${t.baseUrl}/api/continue`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'camp-a' }),
    });
    expect(res.status).toBe(200);
    expect(t.controllers).toHaveLength(1);
    expect(t.controllers[0].startedWith).toBe('resume');
    expect(t.controllers[0].state.campaign.slug).toBe('camp-a');
    expect(t.handle.bridge.hasSession).toBe(true);
    expect(t.handle.bridge.hello().campaign).toEqual({ slug: 'camp-a', name: 'Campaign A' });
  });

  it('404s continuing a campaign that does not exist', async () => {
    const res = await fetch(`${t.baseUrl}/api/continue`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'does-not-exist' }),
    });
    expect(res.status).toBe(404);
  });

  it('400s continuing with no slug', async () => {
    const res = await fetch(`${t.baseUrl}/api/continue`, { method: 'POST', body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  it('409s a second /api/continue while a session is already active', async () => {
    const first = await fetch(`${t.baseUrl}/api/continue`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'camp-a' }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${t.baseUrl}/api/continue`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'camp-a' }),
    });
    expect(second.status).toBe(409);
    expect(t.controllers).toHaveLength(1); // no second controller constructed
  });

  it('/api/end shuts the controller down and clears the session, allowing a fresh /api/continue afterward', async () => {
    await fetch(`${t.baseUrl}/api/continue`, { method: 'POST', body: JSON.stringify({ slug: 'camp-a' }) });
    const endRes = await fetch(`${t.baseUrl}/api/end`, { method: 'POST' });
    expect(endRes.status).toBe(200);
    expect(t.controllers[0].shutdownCalled).toBe(true);
    expect(t.handle.bridge.hasSession).toBe(false);

    const again = await fetch(`${t.baseUrl}/api/continue`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'camp-a' }),
    });
    expect(again.status).toBe(200);
    expect(t.controllers).toHaveLength(2);
  });

  it('/api/end is a harmless no-op when there is no active session', async () => {
    const res = await fetch(`${t.baseUrl}/api/end`, { method: 'POST' });
    expect(res.status).toBe(200);
  });
});

describe('web server: /api/action routing', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await startTestServer(undefined);
    saveGame(makeState('camp-a', 'Campaign A'), t.baseDir);
    await fetch(`${t.baseUrl}/api/continue`, { method: 'POST', body: JSON.stringify({ slug: 'camp-a' }) });
  });
  afterEach(async () => {
    await stopTestServer(t);
  });

  it('routes a plain (non-slash) action to controller.submitPlayerAction', async () => {
    const res = await fetch(`${t.baseUrl}/api/action`, {
      method: 'POST',
      body: JSON.stringify({ text: 'I open the door.' }),
    });
    expect(res.status).toBe(200);
    expect(t.controllers[0].actions).toEqual(['I open the door.']);
  });

  it('400s (no active session) when acting with no session started', async () => {
    await fetch(`${t.baseUrl}/api/end`, { method: 'POST' });
    const res = await fetch(`${t.baseUrl}/api/action`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) });
    expect(res.status).toBe(400);
  });

  it('/help renders the web variant as a system entry, and never reaches submitPlayerAction', async () => {
    await fetch(`${t.baseUrl}/api/action`, { method: 'POST', body: JSON.stringify({ text: '/help' }) });
    expect(t.controllers[0].actions).toEqual([]);
    const entries = t.handle.bridge.hello().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('system');
    expect(entries[0].text).toContain('Commands:');
    expect(entries[0].text).not.toContain('PgUp'); // TUI-only key hint must not leak into the web variant
  });

  it('/sheet renders the character sheet from the loaded state', async () => {
    await fetch(`${t.baseUrl}/api/action`, { method: 'POST', body: JSON.stringify({ text: '/sheet' }) });
    const entries = t.handle.bridge.hello().entries;
    expect(entries[0].text).toContain('Hero — Human Fighter');
  });

  it('/journal renders the chronicle', async () => {
    await fetch(`${t.baseUrl}/api/action`, { method: 'POST', body: JSON.stringify({ text: '/journal' }) });
    const entries = t.handle.bridge.hello().entries;
    expect(entries[0].text.length).toBeGreaterThan(0);
  });

  it('/save calls controller.forceSave and confirms', async () => {
    await fetch(`${t.baseUrl}/api/action`, { method: 'POST', body: JSON.stringify({ text: '/save' }) });
    expect(t.controllers[0].forceSaveCalled).toBe(true);
    const entries = t.handle.bridge.hello().entries;
    expect(entries[0].text).toBe('Saved.');
  });

  it('/retire and /quit point at the web equivalent instead of the legacy terminal', async () => {
    await fetch(`${t.baseUrl}/api/action`, { method: 'POST', body: JSON.stringify({ text: '/retire' }) });
    await fetch(`${t.baseUrl}/api/action`, { method: 'POST', body: JSON.stringify({ text: '/quit' }) });
    const entries = t.handle.bridge.hello().entries;
    expect(entries).toHaveLength(2);
    // Retiring DOES work on web (POST /api/retire via the Retire Hero button),
    // so this note must send the player there -- never to `npm run play`.
    expect(entries[0].text).toMatch(/Retire Hero/);
    expect(entries[0].text.toLowerCase()).not.toMatch(/tui-only|npm run play/);
    expect(entries[1].text.toLowerCase()).toContain('close this tab');
    // Neither reaches the controller as a player action either way.
    expect(t.controllers[0].actions).toEqual([]);
  });

  it('an unrecognized command gets the unknown-command note', async () => {
    await fetch(`${t.baseUrl}/api/action`, { method: 'POST', body: JSON.stringify({ text: '/bogus' }) });
    const entries = t.handle.bridge.hello().entries;
    expect(entries[0].text).toContain('Unknown command');
    expect(entries[0].text).toContain('/bogus');
  });

  it('a blank action is a harmless no-op', async () => {
    const res = await fetch(`${t.baseUrl}/api/action`, { method: 'POST', body: JSON.stringify({ text: '   ' }) });
    expect(res.status).toBe(200);
    expect(t.controllers[0].actions).toEqual([]);
    expect(t.handle.bridge.hello().entries).toEqual([]);
  });
});

describe('web server: dice roll routes', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await startTestServer(undefined);
    saveGame(makeState('camp-a', 'Campaign A'), t.baseDir);
    await fetch(`${t.baseUrl}/api/continue`, { method: 'POST', body: JSON.stringify({ slug: 'camp-a' }) });
  });
  afterEach(async () => {
    await stopTestServer(t);
  });

  function fakeReveal(overrides: Partial<RollRevealResult> = {}): RollRevealResult {
    return {
      message: '🎲 d20 (Persuasion) → [14] = 14 vs DC 13 — ✓ success',
      expr: 'd20',
      reason: 'Persuasion',
      first: { text: '[14]', total: 14 },
      keptTotal: 14,
      dc: 13,
      success: true,
      canReroll: false,
      luck: 1,
      ...overrides,
    };
  }

  it('/api/roll/confirm passes through controller.confirmRoll()\'s result as {reveal}', async () => {
    t.controllers[0].confirmRollResult = fakeReveal();
    const res = await fetch(`${t.baseUrl}/api/roll/confirm`, { method: 'POST' });
    const body = await res.json();
    expect(body.reveal).toEqual(fakeReveal());
  });

  it('/api/roll/confirm returns {reveal: null} when the controller has nothing to confirm', async () => {
    t.controllers[0].confirmRollResult = undefined;
    const res = await fetch(`${t.baseUrl}/api/roll/confirm`, { method: 'POST' });
    const body = await res.json();
    expect(body.reveal).toBeNull();
  });

  it('/api/roll/resolve passes useLuck through to controller.resolvePendingRoll and returns its result', async () => {
    t.controllers[0].resolveRollResult = fakeReveal({ canReroll: false, reroll: { text: '[18]', total: 18 } });
    const res = await fetch(`${t.baseUrl}/api/roll/resolve`, {
      method: 'POST',
      body: JSON.stringify({ useLuck: true }),
    });
    const body = await res.json();
    expect(t.controllers[0].lastResolveUseLuck).toBe(true);
    expect(body.reveal.reroll).toEqual({ text: '[18]', total: 18 });
  });

  it('/api/roll/resolve defaults useLuck to false when omitted', async () => {
    t.controllers[0].resolveRollResult = fakeReveal();
    await fetch(`${t.baseUrl}/api/roll/resolve`, { method: 'POST', body: JSON.stringify({}) });
    expect(t.controllers[0].lastResolveUseLuck).toBe(false);
  });

  it('/api/interrupt calls controller.interrupt()', async () => {
    const res = await fetch(`${t.baseUrl}/api/interrupt`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(t.controllers[0].interrupted).toBe(true);
  });
});

describe('web server: GET /api/presets', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await startTestServer(undefined);
  });
  afterEach(async () => {
    await stopTestServer(t);
  });

  it('derives classes/races/backgrounds/themes/standardArray from newCampaign.ts presets, not hardcoded client data', async () => {
    const res = await fetch(`${t.baseUrl}/api/presets`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Array.isArray(body.classes)).toBe(true);
    const fighter = body.classes.find((c: { id: string }) => c.id === 'fighter');
    expect(fighter).toMatchObject({ id: 'fighter', name: 'Fighter', hitBase: 10, keyStat: 'STR' });
    expect(typeof fighter.tagline).toBe('string');
    expect(fighter.tagline.length).toBeGreaterThan(0);
    expect(fighter.kit).toEqual(['Sword', 'Shield', 'Chainmail', 'Rations ×5']);

    expect(Array.isArray(body.races)).toBe(true);
    expect(body.races[0]).toHaveProperty('id');
    expect(body.races[0]).toHaveProperty('name');
    expect(body.races[0]).toHaveProperty('description');

    expect(Array.isArray(body.backgrounds)).toBe(true);
    expect(body.backgrounds.length).toBeGreaterThan(0);

    expect(Array.isArray(body.themes)).toBe(true);
    expect(body.themes.length).toBeGreaterThan(0);
    // Deliberately EXCLUDED: THEMES' 'custom' row is the terminal wizard's
    // "let me type my own" menu entry and carries an empty seed. The web wizard
    // renders its own custom card with a text input, so serving this one gave
    // two identical "Custom..." cards -- and choosing the preset one made a
    // campaign whose theme was the empty string.
    expect(body.themes.some((th: { id: string }) => th.id === 'custom')).toBe(false);
    expect(body.themes.every((th: { seed: string }) => th.seed.length > 0)).toBe(true);

    expect(body.standardArray).toEqual([15, 14, 13, 12, 10, 8]);
  });

  it('is gated by the PIN like every other data route', async () => {
    const gated = await startTestServer('123456');
    try {
      const res = await fetch(`${gated.baseUrl}/api/presets`);
      expect(res.status).toBe(401);
    } finally {
      await stopTestServer(gated);
    }
  });
});

describe('web server: POST /api/roll-stats', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await startTestServer(undefined);
  });
  afterEach(async () => {
    await stopTestServer(t);
  });

  it('returns six values, each a valid 4d6-drop-lowest roll (3-18)', async () => {
    const res = await fetch(`${t.baseUrl}/api/roll-stats`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.values).toHaveLength(6);
    for (const v of body.values) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(18);
    }
  });

  it('is server-authoritative -- a second call may reroll to different values (the client can "reroll")', async () => {
    const first = await (await fetch(`${t.baseUrl}/api/roll-stats`, { method: 'POST' })).json();
    const second = await (await fetch(`${t.baseUrl}/api/roll-stats`, { method: 'POST' })).json();
    // Not a hard guarantee (could coincidentally match), but astronomically
    // unlikely across 6 independent 4d6-drop-lowest rolls.
    expect(first.values).not.toEqual(second.values);
  });
});

describe('web server: POST /api/new', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await startTestServer(undefined);
  });
  afterEach(async () => {
    await stopTestServer(t);
  });

  function validNewBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: 'My Campaign',
      heroName: 'Theron',
      classId: 'fighter',
      race: 'Human',
      statValues: [15, 14, 13, 12, 10, 8],
      themeSeed: 'classic high fantasy',
      contentRating: 'PG-13',
      ...overrides,
    };
  }

  it('creates + saves a brand-new campaign, starts the controller in "new" mode, and broadcasts a fresh hello', async () => {
    const res = await fetch(`${t.baseUrl}/api/new`, { method: 'POST', body: JSON.stringify(validNewBody()) });
    expect(res.status).toBe(200);
    expect(t.controllers).toHaveLength(1);
    expect(t.controllers[0].startedWith).toBe('new');
    expect(t.controllers[0].state.character.name).toBe('Theron');
    expect(t.controllers[0].state.character.className).toBe('Fighter');
    expect(t.controllers[0].state.world.theme).toBe('classic high fantasy');
    expect(t.handle.bridge.hasSession).toBe(true);

    const listRes = await fetch(`${t.baseUrl}/api/campaigns`);
    const list = await listRes.json();
    expect(list.some((c: { name: string }) => c.name === 'My Campaign')).toBe(true);
  });

  it('409s when a session is already active, and constructs no second controller', async () => {
    await fetch(`${t.baseUrl}/api/new`, { method: 'POST', body: JSON.stringify(validNewBody()) });
    const second = await fetch(`${t.baseUrl}/api/new`, {
      method: 'POST',
      body: JSON.stringify(validNewBody({ name: 'Second Campaign' })),
    });
    expect(second.status).toBe(409);
    expect(t.controllers).toHaveLength(1);
  });

  it('400s on a missing required field', async () => {
    const res = await fetch(`${t.baseUrl}/api/new`, {
      method: 'POST',
      body: JSON.stringify(validNewBody({ heroName: undefined })),
    });
    expect(res.status).toBe(400);
    expect(t.controllers).toHaveLength(0);
  });

  it('400s on an unrecognized classId', async () => {
    const res = await fetch(`${t.baseUrl}/api/new`, {
      method: 'POST',
      body: JSON.stringify(validNewBody({ classId: 'not-a-class' })),
    });
    expect(res.status).toBe(400);
    expect(t.controllers).toHaveLength(0);
  });

  it('400s on a malformed statValues (wrong length)', async () => {
    const res = await fetch(`${t.baseUrl}/api/new`, {
      method: 'POST',
      body: JSON.stringify(validNewBody({ statValues: [15, 14, 13] })),
    });
    expect(res.status).toBe(400);
  });

  it('defaults contentRating to PG-13 when omitted', async () => {
    const body = validNewBody();
    delete body.contentRating;
    const res = await fetch(`${t.baseUrl}/api/new`, { method: 'POST', body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    expect(t.controllers[0].state.campaign.contentRating).toBe('PG-13');
  });
});

describe('web server: POST /api/retire', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await startTestServer(undefined);
    saveGame(makeState('camp-a', 'Campaign A'), t.baseDir);
    await fetch(`${t.baseUrl}/api/continue`, { method: 'POST', body: JSON.stringify({ slug: 'camp-a' }) });
  });
  afterEach(async () => {
    await stopTestServer(t);
  });

  function validRetireBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      heroName: 'Lyra',
      classId: 'rogue',
      race: 'Elf',
      statValues: [15, 14, 13, 12, 10, 8],
      ...overrides,
    };
  }

  it('shuts the old controller down, starts a fresh "new-hero" session in the same world, and broadcasts a fresh hello', async () => {
    const res = await fetch(`${t.baseUrl}/api/retire`, { method: 'POST', body: JSON.stringify(validRetireBody()) });
    expect(res.status).toBe(200);

    expect(t.controllers[0].shutdownCalled).toBe(true);
    expect(t.controllers).toHaveLength(2);
    expect(t.controllers[1].startedWith).toBe('new-hero');
    expect(t.controllers[1].state.character.name).toBe('Lyra');
    expect(t.controllers[1].state.character.className).toBe('Rogue');
    expect(t.controllers[1].state.campaign.slug).toBe('camp-a'); // same persistent world
    expect(t.handle.bridge.hasSession).toBe(true);
  });

  it('appends an "A new hero rises" system transcript note naming the new hero', async () => {
    await fetch(`${t.baseUrl}/api/retire`, { method: 'POST', body: JSON.stringify(validRetireBody()) });
    const transcript = readTranscript('camp-a', t.baseDir);
    const note = transcript.find((e) => e.role === 'system' && e.text.includes('A new hero rises'));
    expect(note).toBeDefined();
    expect(note?.text).toContain('Lyra');
  });

  it('400s when there is no active session', async () => {
    await fetch(`${t.baseUrl}/api/end`, { method: 'POST' });
    const res = await fetch(`${t.baseUrl}/api/retire`, { method: 'POST', body: JSON.stringify(validRetireBody()) });
    expect(res.status).toBe(400);
    expect(t.controllers).toHaveLength(1); // no new controller constructed
  });

  it('400s on missing/invalid fields (e.g. a malformed statValues), leaving the original session untouched', async () => {
    const res = await fetch(`${t.baseUrl}/api/retire`, {
      method: 'POST',
      body: JSON.stringify(validRetireBody({ statValues: [1, 2] })),
    });
    expect(res.status).toBe(400);
    expect(t.controllers).toHaveLength(1);
    expect(t.controllers[0].shutdownCalled).toBe(false);
  });

  it('400s on an unrecognized classId', async () => {
    const res = await fetch(`${t.baseUrl}/api/retire`, {
      method: 'POST',
      body: JSON.stringify(validRetireBody({ classId: 'not-a-class' })),
    });
    expect(res.status).toBe(400);
  });
});

describe('web server: 404s and JSON error bodies', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await startTestServer(undefined);
  });
  afterEach(async () => {
    await stopTestServer(t);
  });

  it('404s an unknown route with a JSON body', async () => {
    const res = await fetch(`${t.baseUrl}/api/nonexistent`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('404s an unknown method on a known path', async () => {
    const res = await fetch(`${t.baseUrl}/api/campaigns`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('400s a malformed JSON body instead of crashing the server', async () => {
    const res = await fetch(`${t.baseUrl}/api/continue`, { method: 'POST', body: '{not json' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
    expect(JSON.stringify(body)).not.toMatch(/at Object|\.ts:\d+/); // no stack trace leakage
  });

  it('the server survives a malformed request and keeps serving subsequent ones', async () => {
    await fetch(`${t.baseUrl}/api/continue`, { method: 'POST', body: '{not json' });
    const res = await fetch(`${t.baseUrl}/`);
    expect(res.status).toBe(200);
  });
});
