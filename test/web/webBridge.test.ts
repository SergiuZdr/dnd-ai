// GameBridge is the pure heart of phone/web play -- no network, no
// filesystem, just ControllerCallbacks-in / SSE-events-out. These tests
// drive it directly (no http.Server, no GameController) by calling the
// ControllerCallbacks attach() hands back, exactly as GameController itself
// would.

import { describe, it, expect } from 'vitest';
import { GameBridge } from '../../src/web/bridge';
import type { SseEvent } from '../../src/web/bridge';
import type { GameState } from '../../src/game/state';
import type { StoryEntry } from '../../src/game/controller';

function makeState(): GameState {
  return {
    campaign: {
      slug: 'bridge-test',
      name: 'Bridge Test',
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
      xp: 0,
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

function collect(bridge: GameBridge): SseEvent[] {
  const events: SseEvent[] = [];
  bridge.subscribe((evt) => events.push(evt));
  return events;
}

describe('GameBridge.hello', () => {
  it('reports no session before attach() is ever called', () => {
    const bridge = new GameBridge();
    expect(bridge.hasSession).toBe(false);
    expect(bridge.hello()).toEqual({
      campaign: null,
      entries: [],
      state: null,
      busy: false,
      pendingRoll: null,
      suggestions: [],
    });
  });

  it('reports the campaign immediately after attach(), before any callback fires', () => {
    const bridge = new GameBridge();
    bridge.attach({ slug: 'bridge-test', name: 'Bridge Test' });
    expect(bridge.hasSession).toBe(true);
    expect(bridge.hello().campaign).toEqual({ slug: 'bridge-test', name: 'Bridge Test' });
  });

  it('reflects onStoryAppend, onHistoryReplay, onStateChange, onBusyChange, onRollPrompt, and onDiceRoll in one composite snapshot', () => {
    const bridge = new GameBridge();
    const cb = bridge.attach({ slug: 'bridge-test', name: 'Bridge Test' });
    const state = makeState();

    cb.onHistoryReplay([{ id: 1, kind: 'dm', text: 'Welcome back.' }]);
    cb.onStoryAppend({ id: 2, kind: 'player', text: 'I look around.' });
    cb.onStateChange(state);
    cb.onBusyChange(true);
    cb.onRollPrompt({ expr: 'd20', reason: 'Persuasion', dc: 13 });
    cb.onDiceRoll('🎲 d20 (Persuasion) → [14] = 14 vs DC 13 — ✓ success');

    const snapshot = bridge.hello();
    expect(snapshot.campaign).toEqual({ slug: 'bridge-test', name: 'Bridge Test' });
    expect(snapshot.entries).toEqual([
      { id: 1, kind: 'dm', text: 'Welcome back.' },
      { id: 2, kind: 'player', text: 'I look around.' },
    ]);
    expect(snapshot.state).toEqual({ character: state.character, world: state.world });
    expect(snapshot.busy).toBe(true);
    expect(snapshot.pendingRoll).toEqual({ expr: 'd20', reason: 'Persuasion', dc: 13 });
    // No diceMessage in the snapshot any more: a roll reaches the client as a
    // 'roll' story entry in sequence, so a reconnect cannot resurrect the last
    // roll and pin it under the input long after that scene ended.
    expect(snapshot).not.toHaveProperty('diceMessage');
  });

  it('resets everything on detach(), and attach() again starts fresh (no leaked entries/state from the old session)', () => {
    const bridge = new GameBridge();
    const cb1 = bridge.attach({ slug: 'first', name: 'First' });
    cb1.onStoryAppend({ id: 1, kind: 'dm', text: 'First session narration.' });
    cb1.onStateChange(makeState());

    bridge.detach();
    expect(bridge.hasSession).toBe(false);
    expect(bridge.hello()).toEqual({
      campaign: null,
      entries: [],
      state: null,
      busy: false,
      pendingRoll: null,
      suggestions: [],
    });

    bridge.attach({ slug: 'second', name: 'Second' });
    expect(bridge.hello().entries).toEqual([]);
    expect(bridge.hello().state).toBeNull();
  });
});

describe('GameBridge sanitized state', () => {
  it('exposes only character + world (no campaign/chronicle), and no functions anywhere', () => {
    const bridge = new GameBridge();
    const cb = bridge.attach({ slug: 'bridge-test', name: 'Bridge Test' });
    cb.onStateChange(makeState());

    const snapshot = bridge.hello().state;
    expect(snapshot).not.toBeNull();
    expect(Object.keys(snapshot as object).sort()).toEqual(['character', 'world']);

    // Deep scan for anything function-typed -- sanitizeState must be pure data.
    const seen = new Set<unknown>();
    function assertNoFunctions(value: unknown): void {
      if (value === null || typeof value !== 'object') {
        expect(typeof value).not.toBe('function');
        return;
      }
      if (seen.has(value)) return;
      seen.add(value);
      for (const v of Object.values(value as Record<string, unknown>)) assertNoFunctions(v);
    }
    assertNoFunctions(snapshot);

    // Round-trips cleanly through JSON (what actually goes out over SSE/HTTP).
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  });

  it('is a true point-in-time copy: mutating the live GameState afterward does not retroactively change an already-captured snapshot', () => {
    const bridge = new GameBridge();
    const cb = bridge.attach({ slug: 'bridge-test', name: 'Bridge Test' });
    const state = makeState();
    cb.onStateChange(state);
    const firstSnapshot = bridge.hello().state!;

    state.character.hp = 1; // simulate the Engine mutating in place
    cb.onStateChange(state);

    expect(firstSnapshot.character.hp).toBe(12); // unchanged -- captured before the mutation
    expect(bridge.hello().state!.character.hp).toBe(1); // the NEW snapshot reflects it
  });
});

describe('GameBridge SSE fan-out', () => {
  it('broadcasts every event to all connected clients, and stops once unsubscribed', () => {
    const bridge = new GameBridge();
    const cb = bridge.attach({ slug: 'bridge-test', name: 'Bridge Test' });

    const clientA: SseEvent[] = [];
    const clientB: SseEvent[] = [];
    bridge.subscribe((evt) => clientA.push(evt));
    const unsubscribeB = bridge.subscribe((evt) => clientB.push(evt));
    expect(bridge.clientCount).toBe(2);

    // onDiceRoll is intentionally inert on the bridge now -- the roll reaches
    // the client as a 'roll' story entry, in sequence, rather than as a
    // separate event that also had to be mirrored into snapshot state.
    cb.onDiceRoll('🎲 d20 → 10');
    expect(clientA).toHaveLength(0);

    cb.onStoryAppend({ id: 7, kind: 'roll', text: '🎲 d20 → 10' });
    expect(clientA).toHaveLength(1);
    expect(clientB).toHaveLength(1);
    expect(clientA[0]).toEqual({ event: 'story', data: { id: 7, kind: 'roll', text: '🎲 d20 → 10' } });
    expect(clientB[0]).toEqual(clientA[0]);

    unsubscribeB();
    expect(bridge.clientCount).toBe(1);
    cb.onSystemNote('Interrupted.');
    expect(clientA).toHaveLength(2);
    expect(clientB).toHaveLength(1); // did not receive the second event
  });

  it('emits the correct event name/shape for every ControllerCallbacks method', () => {
    const bridge = new GameBridge();
    const cb = bridge.attach({ slug: 'bridge-test', name: 'Bridge Test' });
    const events = collect(bridge);
    const state = makeState();

    cb.onStoryAppend({ id: 1, kind: 'dm', text: 'Hello.' });
    cb.onStreamText('partial text');
    cb.onStateChange(state);
    cb.onDiceRoll('🎲 d20 → 12');
    cb.onBusyChange(true);
    cb.onSystemNote('A note.');
    cb.onRollPrompt({ expr: 'd20', reason: 'test' });
    cb.onHistoryReplay([{ id: 2, kind: 'player', text: 'replayed' }]);

    expect(events.map((e) => e.event)).toEqual([
      'story',
      'stream',
      'state',
      'busy',
      'note',
      'roll',
      'replay',
    ]);
    expect(events[0].data).toEqual({ id: 1, kind: 'dm', text: 'Hello.' });
    expect(events[1].data).toEqual({ text: 'partial text' });
    expect(events[2].data).toEqual({ character: state.character, world: state.world });
    expect(events[3].data).toEqual({ busy: true });
    expect(events[4].data).toEqual({ text: 'A note.' });
    expect(events[5].data).toEqual({ expr: 'd20', reason: 'test' });
    expect(events[6].data).toEqual({ entries: [{ id: 2, kind: 'player', text: 'replayed' }] });
  });
});

describe('GameBridge roll lifecycle mirroring', () => {
  it('mirrors onRollPrompt in both directions: set on request, cleared on null', () => {
    const bridge = new GameBridge();
    const cb = bridge.attach({ slug: 'bridge-test', name: 'Bridge Test' });
    const events = collect(bridge);

    cb.onRollPrompt({ expr: 'd20+3', reason: 'Persuasion', dc: 13 });
    expect(bridge.hello().pendingRoll).toEqual({ expr: 'd20+3', reason: 'Persuasion', dc: 13 });

    cb.onRollPrompt(null);
    expect(bridge.hello().pendingRoll).toBeNull();

    expect(events.map((e) => e.event)).toEqual(['roll', 'roll']);
    expect(events[0].data).toEqual({ expr: 'd20+3', reason: 'Persuasion', dc: 13 });
    expect(events[1].data).toBeNull();
  });
});

describe('GameBridge suggested actions (onSuggestions -> "suggest" SSE event)', () => {
  it('broadcasts a "suggest" event with the action labels', () => {
    const bridge = new GameBridge();
    const cb = bridge.attach({ slug: 'bridge-test', name: 'Bridge Test' });
    const events = collect(bridge);

    cb.onSuggestions?.(['Slip out the back', 'Bluff the constable']);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      event: 'suggest',
      data: { actions: ['Slip out the back', 'Bluff the constable'] },
    });
  });

  // Unlike 'note'/'ledger', these belong to the scene currently on screen: a
  // phone that locks and reconnects mid-scene must get its chips back.
  it('mirrors the latest actions into hello() so a reconnect keeps its chips', () => {
    const bridge = new GameBridge();
    const cb = bridge.attach({ slug: 'bridge-test', name: 'Bridge Test' });

    cb.onSuggestions?.(['Draw your dagger']);
    expect(bridge.hello().suggestions).toEqual(['Draw your dagger']);

    // Cleared when the player acts -- stale chips must not survive the turn.
    cb.onSuggestions?.([]);
    expect(bridge.hello().suggestions).toEqual([]);
  });

  it('does not let a caller mutate the mirrored list through the snapshot', () => {
    const bridge = new GameBridge();
    const cb = bridge.attach({ slug: 'bridge-test', name: 'Bridge Test' });
    cb.onSuggestions?.(['Listen at the door']);

    bridge.hello().suggestions.push('injected');
    expect(bridge.hello().suggestions).toEqual(['Listen at the door']);
  });

  it('starts empty on a fresh attach so a new session never inherits old chips', () => {
    const bridge = new GameBridge();
    const cb = bridge.attach({ slug: 'first', name: 'First' });
    cb.onSuggestions?.(['Old action']);

    bridge.attach({ slug: 'second', name: 'Second' });
    expect(bridge.hello().suggestions).toEqual([]);
  });
});

describe('GameBridge ledger events (onLedgerGain -> "ledger" SSE event)', () => {
  it('broadcasts a "ledger" event with the delta verbatim', () => {
    const bridge = new GameBridge();
    const cb = bridge.attach({ slug: 'bridge-test', name: 'Bridge Test' });
    const events = collect(bridge);

    cb.onLedgerGain?.({ gold: 50, itemsAdded: [{ name: 'Silver Key', qty: 1 }] });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      event: 'ledger',
      data: { gold: 50, itemsAdded: [{ name: 'Silver Key', qty: 1 }] },
    });
  });

  it('is transient like onSystemNote -- never replayed by hello() for a fresh connection', () => {
    const bridge = new GameBridge();
    const cb = bridge.attach({ slug: 'bridge-test', name: 'Bridge Test' });

    cb.onLedgerGain?.({ xp: 100, leveledTo: 3 });

    const snapshot = bridge.hello();
    expect(JSON.stringify(snapshot)).not.toContain('leveledTo');
    expect(Object.keys(snapshot)).toEqual([
      'campaign',
      'entries',
      'state',
      'busy',
      'pendingRoll',
      'suggestions',
    ]);
  });
});

describe('GameBridge.broadcastHello', () => {
  it('broadcasts a fresh "hello" event with the current snapshot to every connected client', () => {
    const bridge = new GameBridge();
    const cb = bridge.attach({ slug: 'bridge-test', name: 'Bridge Test' });
    cb.onStoryAppend({ id: 1, kind: 'dm', text: 'Welcome.' });
    cb.onBusyChange(true);

    const events = collect(bridge);
    bridge.broadcastHello();

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('hello');
    expect(events[0].data).toEqual(bridge.hello());
    expect((events[0].data as { busy: boolean }).busy).toBe(true);
  });

  it('reflects a session change (e.g. after a fresh attach()) to clients that were already connected', () => {
    const bridge = new GameBridge();
    bridge.attach({ slug: 'first', name: 'First' });
    const events = collect(bridge);

    bridge.detach();
    bridge.attach({ slug: 'second', name: 'Second' });
    bridge.broadcastHello();

    expect(events).toHaveLength(1);
    expect((events[0].data as { campaign: unknown }).campaign).toEqual({ slug: 'second', name: 'Second' });
  });
});

describe('GameBridge.appendSystemEntry (local slash-command results)', () => {
  it('appends a system-kind StoryEntry, broadcasts it as a normal "story" event, and persists it in hello()', () => {
    const bridge = new GameBridge();
    bridge.attach({ slug: 'bridge-test', name: 'Bridge Test' });
    const events = collect(bridge);

    bridge.appendSystemEntry('Saved.');

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('story');
    const entry = events[0].data as StoryEntry;
    expect(entry.kind).toBe('system');
    expect(entry.text).toBe('Saved.');

    expect(bridge.hello().entries).toContainEqual(entry);
  });

  it('assigns ids that never collide with the controller-driven (positive, incrementing) StoryEntry ids', () => {
    const bridge = new GameBridge();
    const cb = bridge.attach({ slug: 'bridge-test', name: 'Bridge Test' });

    cb.onStoryAppend({ id: 1, kind: 'player', text: 'action one' });
    bridge.appendSystemEntry('Saved.');
    cb.onStoryAppend({ id: 2, kind: 'dm', text: 'narration two' });
    bridge.appendSystemEntry('Unknown command.');

    const ids = bridge.hello().entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(ids.filter((id) => id > 0)).toEqual([1, 2]);
    expect(ids.filter((id) => id < 0).length).toBe(2);
  });
});
