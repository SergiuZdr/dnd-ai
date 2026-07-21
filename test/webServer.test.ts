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
import { createGameServer } from '../src/web/server';
import type { GameServerHandle, GameControllerLike } from '../src/web/server';
import type { GameState } from '../src/game/state';
import type { ControllerCallbacks, RollRevealResult } from '../src/game/controller';
import { saveGame } from '../src/game/saves';

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

async function startTestServer(pin?: string): Promise<TestServer> {
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

  it('/retire and /quit return a TUI-only note instead of doing anything', async () => {
    await fetch(`${t.baseUrl}/api/action`, { method: 'POST', body: JSON.stringify({ text: '/retire' }) });
    await fetch(`${t.baseUrl}/api/action`, { method: 'POST', body: JSON.stringify({ text: '/quit' }) });
    const entries = t.handle.bridge.hello().entries;
    expect(entries).toHaveLength(2);
    expect(entries[0].text.toLowerCase()).toContain('tui-only');
    expect(entries[1].text.toLowerCase()).toMatch(/close this tab|tui/);
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
