// Multi-player HTTP-contract tests: real http.Server, real fetch(), real
// player registry on disk, fake GameController (a real one would spawn a
// DmSession the instant start() is called).
//
// The load-bearing tests here are the isolation ones. Before per-player
// sessions the server held ONE controller and ONE GameBridge whose broadcasts
// went to every connected client, so a second player would have received the
// first player's narration over SSE. "Each player has their own save" is only
// true if that can't happen, so these assert it directly rather than trusting
// the refactor.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createGameServer } from '../../src/web/server';
import type { GameServerHandle, GameControllerLike } from '../../src/web/server';
import type { GameState } from '../../src/game/state';
import type { ControllerCallbacks } from '../../src/game/controller';
import { saveGame } from '../../src/game/saves';
import { addPlayer, playerSavesDir } from '../../src/game/players';

function makeState(slug: string, name: string, heroName = 'Hero'): GameState {
  return {
    campaign: { slug, name, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z', contentRating: 'PG-13' },
    character: {
      name: heroName, className: 'Fighter', race: 'Human', background: '', backgroundFact: '',
      level: 1, xp: 0, hp: 12, maxHp: 12, ac: 15,
      stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
      gold: 10, inventory: [], luck: 1,
    },
    world: { theme: 'classic fantasy', location: 'Starting Village', npcs: [], quests: [], facts: [] },
    chronicle: { storySoFar: '', chapters: [], lastSummarizedIndex: 0 },
  };
}

class FakeController implements GameControllerLike {
  startedWith: 'new' | 'resume' | 'new-hero' | null = null;
  shutdownCalled = false;
  constructor(public readonly state: GameState, public readonly cb: ControllerCallbacks) {}
  start(mode: 'new' | 'resume' | 'new-hero'): void { this.startedWith = mode; }
  submitPlayerAction(): void {}
  confirmRoll(): undefined { return undefined; }
  resolvePendingRoll(): undefined { return undefined; }
  async interrupt(): Promise<void> {}
  async shutdown(): Promise<void> { this.shutdownCalled = true; }
  forceSave(): void {}
}

let baseDir: string;
let handle: GameServerHandle;
let baseUrl: string;
let controllers: FakeController[];

async function start(): Promise<void> {
  controllers = [];
  handle = createGameServer({
    baseDir,
    pin: 'ignored-in-multiplayer-mode',
    controllerFactory: (state, cb) => {
      const c = new FakeController(state, cb);
      controllers.push(c);
      return c;
    },
  });
  await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
}

/** Reads SSE events off a live stream for `ms`, then aborts and returns the raw text. */
/**
 * Reads an SSE stream until `until` is satisfied, or the deadline passes.
 *
 * The previous version raced every reader.read() against a fresh 60ms timer
 * and dropped the chunk whenever the timer won -- so a frame that arrived a
 * few milliseconds late was silently thrown away and the assertion failed
 * about one run in three. The deadline is now created ONCE (a real overall
 * budget, not a per-chunk one) and reads are awaited whole, so nothing is
 * discarded mid-stream. Assertions about content ARRIVING should pass `until`
 * and finish the moment it does; assertions about content NOT arriving leave
 * it unset and spend the full window, which is exactly what they need.
 */
async function collectSse(code: string, ms = 250, until?: (text: string) => boolean): Promise<string> {
  const ac = new AbortController();
  const res = await fetch(`${baseUrl}/api/events?pin=${encodeURIComponent(code)}`, { signal: ac.signal });
  const reader = res.body!.getReader();
  let text = '';
  const deadline = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms));
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === 'timeout' || next.done) break;
      if (next.value) text += new TextDecoder().decode(next.value);
      if (until?.(text)) break;
    }
  } finally {
    ac.abort();
    try {
      reader.releaseLock();
    } catch {
      // already released by abort
    }
  }
  return text;
}

const post = (p: string, code: string, body: unknown = {}) =>
  fetch(`${baseUrl}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Game-Pin': code }, body: JSON.stringify(body) });
const get = (p: string, code: string) => fetch(`${baseUrl}${p}`, { headers: { 'X-Game-Pin': code } });

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-web-players-'));
});

afterEach(async () => {
  if (handle) await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('access-code auth', () => {
  it('accepts a valid code and rejects a wrong one, ignoring GAME_PIN entirely', async () => {
    const alice = addPlayer(baseDir, 'Alice');
    await start();

    expect((await get('/api/campaigns', alice.code)).status).toBe(200);
    expect((await get('/api/campaigns', 'ffff-ffff-ffff-ffff-ffff-ffff')).status).toBe(401);
    // The shared PIN stops being a credential the moment players exist.
    expect((await get('/api/campaigns', 'ignored-in-multiplayer-mode')).status).toBe(401);
  });

  it('accepts a code typed without its dashes', async () => {
    const alice = addPlayer(baseDir, 'Alice');
    await start();
    expect((await get('/api/campaigns', alice.code.replace(/-/g, ''))).status).toBe(200);
  });

  it('still serves GET / unauthenticated, so the login screen can load', async () => {
    addPlayer(baseDir, 'Alice');
    await start();
    expect((await fetch(`${baseUrl}/`)).status).toBe(200);
  });

  describe('GET /api/auth-mode', () => {
    // Must be unauthenticated: the login screen has to know whether to render a
    // 6-cell numeric PIN field or a wide access-code field before the player can
    // type anything, and a numeric field cannot accept a 29-char code.
    it('reports "pin" with no players and "code" once one exists, without a credential', async () => {
      await start();
      expect(await (await fetch(`${baseUrl}/api/auth-mode`)).json()).toEqual({ mode: 'pin' });

      addPlayer(baseDir, 'Alice');
      expect(await (await fetch(`${baseUrl}/api/auth-mode`)).json()).toEqual({ mode: 'code' });
    });

    it('leaks nothing beyond the mode itself', async () => {
      const alice = addPlayer(baseDir, 'Alice');
      await start();
      const raw = await (await fetch(`${baseUrl}/api/auth-mode`)).text();
      expect(Object.keys(JSON.parse(raw))).toEqual(['mode']);
      expect(raw).not.toContain('alice');
      expect(raw).not.toContain(alice.code.slice(0, 4));
    });
  });

  it('falls back to shared-PIN mode when no players are registered', async () => {
    await start(); // registry empty
    expect((await get('/api/campaigns', 'ignored-in-multiplayer-mode')).status).toBe(200);
    expect((await get('/api/campaigns', 'wrong')).status).toBe(401);
  });

  it('switches to code auth as soon as the first player is added, with no restart', async () => {
    await start();
    expect((await get('/api/campaigns', 'ignored-in-multiplayer-mode')).status).toBe(200);

    const alice = addPlayer(baseDir, 'Alice');
    expect((await get('/api/campaigns', 'ignored-in-multiplayer-mode')).status).toBe(401);
    expect((await get('/api/campaigns', alice.code)).status).toBe(200);
  });
});

describe('save isolation', () => {
  it('each player sees only their own campaigns', async () => {
    const alice = addPlayer(baseDir, 'Alice');
    const bob = addPlayer(baseDir, 'Bob');
    saveGame(makeState('alice-camp', 'Alice Campaign'), playerSavesDir(baseDir, 'alice'));
    saveGame(makeState('bob-camp', 'Bob Campaign'), playerSavesDir(baseDir, 'bob'));
    await start();

    const aliceList = await (await get('/api/campaigns', alice.code)).json();
    const bobList = await (await get('/api/campaigns', bob.code)).json();
    expect(aliceList.map((c: { slug: string }) => c.slug)).toEqual(['alice-camp']);
    expect(bobList.map((c: { slug: string }) => c.slug)).toEqual(['bob-camp']);
  });

  it("404s when a player tries to open someone else's campaign by slug", async () => {
    const alice = addPlayer(baseDir, 'Alice');
    const bob = addPlayer(baseDir, 'Bob');
    saveGame(makeState('alice-camp', 'Alice Campaign'), playerSavesDir(baseDir, 'alice'));
    await start();

    // Guessing the slug must not be enough -- authorisation is the save path.
    expect((await post('/api/continue', bob.code, { slug: 'alice-camp' })).status).toBe(404);
    expect((await post('/api/continue', alice.code, { slug: 'alice-camp' })).status).toBe(200);
  });

  it('writes a new campaign into the creating player\'s own directory', async () => {
    const alice = addPlayer(baseDir, 'Alice');
    addPlayer(baseDir, 'Bob');
    await start();

    const res = await post('/api/new', alice.code, {
      name: 'Alice World', heroName: 'Ayla', classId: 'fighter', race: 'Human',
      statValues: [15, 14, 13, 12, 10, 8], themeSeed: 'a quiet village', contentRating: 'PG-13',
    });
    expect(res.status).toBe(200);
    expect(fs.readdirSync(playerSavesDir(baseDir, 'alice'))).not.toHaveLength(0);
    expect(fs.existsSync(playerSavesDir(baseDir, 'bob'))).toBe(true);
    expect(fs.readdirSync(playerSavesDir(baseDir, 'bob'))).toHaveLength(0);
  });
});

describe('session isolation', () => {
  it('two players hold independent live sessions at the same time', async () => {
    const alice = addPlayer(baseDir, 'Alice');
    const bob = addPlayer(baseDir, 'Bob');
    saveGame(makeState('alice-camp', 'Alice Campaign', 'Ayla'), playerSavesDir(baseDir, 'alice'));
    saveGame(makeState('bob-camp', 'Bob Campaign', 'Borin'), playerSavesDir(baseDir, 'bob'));
    await start();

    // Alice starting a game must NOT make Bob's /api/continue 409.
    expect((await post('/api/continue', alice.code, { slug: 'alice-camp' })).status).toBe(200);
    expect((await post('/api/continue', bob.code, { slug: 'bob-camp' })).status).toBe(200);

    expect(controllers).toHaveLength(2);
    expect(controllers[0].state.character.name).toBe('Ayla');
    expect(controllers[1].state.character.name).toBe('Borin');
  });

  it("a player's own second session is still refused with 409", async () => {
    const alice = addPlayer(baseDir, 'Alice');
    saveGame(makeState('alice-camp', 'Alice Campaign'), playerSavesDir(baseDir, 'alice'));
    saveGame(makeState('alice-two', 'Alice Second'), playerSavesDir(baseDir, 'alice'));
    await start();

    expect((await post('/api/continue', alice.code, { slug: 'alice-camp' })).status).toBe(200);
    expect((await post('/api/continue', alice.code, { slug: 'alice-two' })).status).toBe(409);
  });

  it('/api/end ends only the calling player\'s session', async () => {
    const alice = addPlayer(baseDir, 'Alice');
    const bob = addPlayer(baseDir, 'Bob');
    saveGame(makeState('alice-camp', 'A'), playerSavesDir(baseDir, 'alice'));
    saveGame(makeState('bob-camp', 'B'), playerSavesDir(baseDir, 'bob'));
    await start();
    await post('/api/continue', alice.code, { slug: 'alice-camp' });
    await post('/api/continue', bob.code, { slug: 'bob-camp' });

    await post('/api/end', alice.code);
    expect(controllers[0].shutdownCalled).toBe(true);
    expect(controllers[1].shutdownCalled).toBe(false);
    // Bob is untouched and can still act.
    expect((await post('/api/action', bob.code, { text: 'I look around' })).status).toBe(200);
    // Alice's is gone, so hers reports no session.
    expect((await post('/api/action', alice.code, { text: 'hi' })).status).toBe(400);
  });

  it('shutdown() drains every player\'s controller, not just one', async () => {
    const alice = addPlayer(baseDir, 'Alice');
    const bob = addPlayer(baseDir, 'Bob');
    saveGame(makeState('alice-camp', 'A'), playerSavesDir(baseDir, 'alice'));
    saveGame(makeState('bob-camp', 'B'), playerSavesDir(baseDir, 'bob'));
    await start();
    await post('/api/continue', alice.code, { slug: 'alice-camp' });
    await post('/api/continue', bob.code, { slug: 'bob-camp' });

    // On SIGTERM every player must get their autosave, not whoever was last.
    await handle.shutdown();
    expect(controllers.map((c) => c.shutdownCalled)).toEqual([true, true]);
  });
});

describe('SSE isolation (the leak this refactor exists to close)', () => {
  it("one player's narration never reaches another player's stream", async () => {
    const alice = addPlayer(baseDir, 'Alice');
    const bob = addPlayer(baseDir, 'Bob');
    saveGame(makeState('alice-camp', 'Alice Campaign', 'Ayla'), playerSavesDir(baseDir, 'alice'));
    saveGame(makeState('bob-camp', 'Bob Campaign', 'Borin'), playerSavesDir(baseDir, 'bob'));
    await start();
    await post('/api/continue', alice.code, { slug: 'alice-camp' });
    await post('/api/continue', bob.code, { slug: 'bob-camp' });

    const aliceController = controllers.find((c) => c.state.campaign.slug === 'alice-camp')!;

    // Listen as Bob, then push a story beat into Alice's session.
    const bobStream = collectSse(bob.code, 300);
    await new Promise((r) => setTimeout(r, 60));
    aliceController.cb.onStoryAppend({ id: 1, kind: 'dm', text: 'ALICE SECRET NARRATION' });
    aliceController.cb.onStateChange({
      ...aliceController.state,
      character: { ...aliceController.state.character, gold: 9999 },
    });
    const bobText = await bobStream;

    expect(bobText).not.toContain('ALICE SECRET NARRATION');
    expect(bobText).not.toContain('9999');
    // Bob did get his own hello, so the stream itself is working.
    expect(bobText).toContain('event: hello');
    expect(bobText).toContain('Bob Campaign');
    expect(bobText).not.toContain('Alice Campaign');
  });

  it("a player's own stream does receive their own narration", async () => {
    const alice = addPlayer(baseDir, 'Alice');
    saveGame(makeState('alice-camp', 'Alice Campaign'), playerSavesDir(baseDir, 'alice'));
    await start();
    await post('/api/continue', alice.code, { slug: 'alice-camp' });
    const controller = controllers[0];

    const stream = collectSse(alice.code, 3000, (t) => t.includes('HER OWN NARRATION'));
    await new Promise((r) => setTimeout(r, 60));
    controller.cb.onStoryAppend({ id: 1, kind: 'dm', text: 'HER OWN NARRATION' });
    expect(await stream).toContain('HER OWN NARRATION');
  });

  it('rejects an SSE connection with a bad code instead of attaching it to anything', async () => {
    addPlayer(baseDir, 'Alice');
    await start();
    const res = await fetch(`${baseUrl}/api/events?pin=nope`);
    expect(res.status).toBe(401);
  });
});

describe('deleting a campaign', () => {
  it("retires the caller's own campaign and drops it from their list", async () => {
    const alice = addPlayer(baseDir, 'Alice');
    saveGame(makeState('keep-me', 'Keep Me'), playerSavesDir(baseDir, 'alice'));
    saveGame(makeState('bin-me', 'Bin Me'), playerSavesDir(baseDir, 'alice'));
    await start();

    expect((await post('/api/campaign/delete', alice.code, { slug: 'bin-me' })).status).toBe(200);
    const list = await (await get('/api/campaigns', alice.code)).json();
    expect(list.map((c: { slug: string }) => c.slug)).toEqual(['keep-me']);
  });

  it('moves it to .deleted rather than destroying it outright', async () => {
    const alice = addPlayer(baseDir, 'Alice');
    saveGame(makeState('bin-me', 'Bin Me'), playerSavesDir(baseDir, 'alice'));
    await start();
    await post('/api/campaign/delete', alice.code, { slug: 'bin-me' });

    // Weeks of play should survive a mis-tap: the folder is recoverable by hand.
    const trash = path.join(playerSavesDir(baseDir, 'alice'), '.deleted');
    const retired = fs.readdirSync(trash);
    expect(retired).toHaveLength(1);
    expect(retired[0]).toMatch(/^bin-me-/);
    expect(fs.existsSync(path.join(trash, retired[0], 'campaign.json'))).toBe(true);
  });

  it('never lists .deleted as if it were a campaign', async () => {
    const alice = addPlayer(baseDir, 'Alice');
    saveGame(makeState('bin-me', 'Bin Me'), playerSavesDir(baseDir, 'alice'));
    await start();
    await post('/api/campaign/delete', alice.code, { slug: 'bin-me' });
    expect(await (await get('/api/campaigns', alice.code)).json()).toEqual([]);
  });

  it("cannot be aimed at another player's campaign, even by slug traversal", async () => {
    const alice = addPlayer(baseDir, 'Alice');
    const bob = addPlayer(baseDir, 'Bob');
    saveGame(makeState('precious', 'Alice Precious'), playerSavesDir(baseDir, 'alice'));
    await start();

    // Plain slug: not in Bob's directory at all.
    expect((await post('/api/campaign/delete', bob.code, { slug: 'precious' })).status).toBe(404);
    // Traversal: path.join would happily resolve this into Alice's folder, so
    // savePaths' containment check is the only thing standing between Bob and
    // deleting someone else's campaign.
    for (const slug of ['../alice/precious', '../../players/alice/precious', 'x/../../alice/precious']) {
      const res = await post('/api/campaign/delete', bob.code, { slug });
      expect(res.status).toBe(400);
    }
    expect(fs.existsSync(path.join(playerSavesDir(baseDir, 'alice'), 'precious', 'campaign.json'))).toBe(true);
  });

  it('shuts the session down first when deleting the campaign currently being played', async () => {
    const alice = addPlayer(baseDir, 'Alice');
    saveGame(makeState('live-one', 'Live One'), playerSavesDir(baseDir, 'alice'));
    await start();
    await post('/api/continue', alice.code, { slug: 'live-one' });

    expect((await post('/api/campaign/delete', alice.code, { slug: 'live-one' })).status).toBe(200);
    // Otherwise a live GameController keeps autosaving and recreates the folder.
    expect(controllers[0].shutdownCalled).toBe(true);
    expect(await (await get('/api/campaigns', alice.code)).json()).toEqual([]);
    expect((await post('/api/action', alice.code, { text: 'hello' })).status).toBe(400);
  });

  it('404s an unknown slug and 400s a missing one', async () => {
    const alice = addPlayer(baseDir, 'Alice');
    await start();
    expect((await post('/api/campaign/delete', alice.code, { slug: 'nope' })).status).toBe(404);
    expect((await post('/api/campaign/delete', alice.code, {})).status).toBe(400);
  });

  it('requires authentication', async () => {
    addPlayer(baseDir, 'Alice');
    await start();
    expect((await post('/api/campaign/delete', 'ffff-ffff-ffff-ffff-ffff-ffff', { slug: 'x' })).status).toBe(401);
  });
});

describe('SSE tickets (keeping the access code out of URLs)', () => {
  it('issues a ticket that opens the stream for the right player', async () => {
    const alice = addPlayer(baseDir, 'Alice');
    saveGame(makeState('alice-camp', 'Alice Campaign'), playerSavesDir(baseDir, 'alice'));
    await start();
    await post('/api/continue', alice.code, { slug: 'alice-camp' });

    const { ticket } = await (await post('/api/sse-ticket', alice.code)).json();
    expect(typeof ticket).toBe('string');
    expect(ticket).not.toContain(alice.code.slice(0, 4)); // opaque, not a wrapper round the code

    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/api/events?ticket=${ticket}`, { signal: ac.signal });
    expect(res.status).toBe(200);
    const chunk = await res.body!.getReader().read();
    expect(new TextDecoder().decode(chunk.value)).toContain('connected');
    ac.abort();
  });

  it('burns the ticket on first use, so a leaked one is worth nothing', async () => {
    const alice = addPlayer(baseDir, 'Alice');
    await start();
    const { ticket } = await (await post('/api/sse-ticket', alice.code)).json();

    const ac = new AbortController();
    expect((await fetch(`${baseUrl}/api/events?ticket=${ticket}`, { signal: ac.signal })).status).toBe(200);
    ac.abort();
    // Second attempt with the same ticket must not authenticate. This is also
    // exactly why the client can't rely on EventSource's built-in retry, which
    // would re-request this identical URL -- see openEventStream/scheduleSseReconnect.
    expect((await fetch(`${baseUrl}/api/events?ticket=${ticket}`)).status).toBe(401);
  });

  it('refuses an unknown or forged ticket', async () => {
    addPlayer(baseDir, 'Alice');
    await start();
    expect((await fetch(`${baseUrl}/api/events?ticket=deadbeef`)).status).toBe(401);
  });

  it("a ticket only ever opens its own issuer's stream", async () => {
    const alice = addPlayer(baseDir, 'Alice');
    const bob = addPlayer(baseDir, 'Bob');
    saveGame(makeState('alice-camp', 'Alice Campaign'), playerSavesDir(baseDir, 'alice'));
    saveGame(makeState('bob-camp', 'Bob Campaign'), playerSavesDir(baseDir, 'bob'));
    await start();
    await post('/api/continue', alice.code, { slug: 'alice-camp' });
    await post('/api/continue', bob.code, { slug: 'bob-camp' });

    const { ticket } = await (await post('/api/sse-ticket', bob.code)).json();
    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/api/events?ticket=${ticket}`, { signal: ac.signal });
    const text = new TextDecoder().decode((await res.body!.getReader().read()).value);
    ac.abort();
    // The hello snapshot must be Bob's campaign, never Alice's.
    expect(text).not.toContain('Alice Campaign');
  });

  it('requires a real credential to get a ticket in the first place', async () => {
    addPlayer(baseDir, 'Alice');
    await start();
    expect((await post('/api/sse-ticket', 'ffff-ffff-ffff-ffff-ffff-ffff')).status).toBe(401);
  });

  it('works in single-player PIN mode too', async () => {
    await start(); // no players -> solo session
    const { ticket } = await (await post('/api/sse-ticket', 'ignored-in-multiplayer-mode')).json();
    const ac = new AbortController();
    expect((await fetch(`${baseUrl}/api/events?ticket=${ticket}`, { signal: ac.signal })).status).toBe(200);
    ac.abort();
  });
});
