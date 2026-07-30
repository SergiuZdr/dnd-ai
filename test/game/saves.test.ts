import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  slugify,
  saveGame,
  loadGame,
  listCampaigns,
  deleteCampaign,
  latestCampaign,
  appendTranscript,
  readTranscript,
} from '../../src/game/saves';
import type { GameState } from '../../src/game/state';
import { SCHEMA_VERSION } from '../../src/game/state';

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
      background: 'Wanderer',
      backgroundFact: "has wandered many roads before this one",
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
    world: {
      theme: 'classic fantasy',
      location: 'Starting Village',
      npcs: [{ name: 'Elandra', disposition: 'friendly', status: 'alive', facts: ['Runs the tavern'] }],
      quests: [{ title: 'Find the Amulet', status: 'active', notes: ['Started the search'] }],
      facts: ['The king is missing.'],
    },
    chronicle: {
      storySoFar: 'Our hero arrived in town.',
      chapters: [{ summary: 'Chapter 1', endedAtExchange: 10 }],
      lastSummarizedIndex: 10,
    },
  };
}

describe('saves', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-saves-'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  describe('slugify', () => {
    it('lowercases, hyphenates non-alnum runs, and trims edge hyphens', () => {
      expect(slugify('My Grand Campaign!!')).toBe('my-grand-campaign');
      expect(slugify('Already-Slugged')).toBe('already-slugged');
      expect(slugify('  Weird   Spacing__Here  ')).toBe('weird-spacing-here');
    });

    it('falls back to "campaign" for empty or all-punctuation input', () => {
      expect(slugify('   ')).toBe('campaign');
      expect(slugify('---')).toBe('campaign');
      expect(slugify('!!!')).toBe('campaign');
      expect(slugify('')).toBe('campaign');
    });
  });

  describe('saveGame / loadGame', () => {
    it('round-trips a full game state through save and load', () => {
      const state = makeState('round-trip', 'Round Trip Campaign');
      saveGame(state, baseDir);
      const loaded = loadGame('round-trip', baseDir);
      expect(loaded).toEqual(state);
    });

    it('refreshes campaign.updatedAt on save', () => {
      const state = makeState('refresh-test', 'Refresh Test');
      state.campaign.updatedAt = '2000-01-01T00:00:00.000Z';
      saveGame(state, baseDir);
      expect(state.campaign.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');
      expect(Number.isNaN(new Date(state.campaign.updatedAt).getTime())).toBe(false);

      const loaded = loadGame('refresh-test', baseDir);
      expect(loaded.campaign.updatedAt).toBe(state.campaign.updatedAt);
    });

    it('creates the campaign directory recursively when it does not yet exist', () => {
      const state = makeState('brand-new', 'Brand New');
      expect(fs.existsSync(path.join(baseDir, 'brand-new'))).toBe(false);
      saveGame(state, baseDir);
      expect(fs.existsSync(path.join(baseDir, 'brand-new', 'campaign.json'))).toBe(true);
    });

    it('leaves no .tmp files behind after a save', () => {
      const state = makeState('tmp-check', 'Tmp Check');
      saveGame(state, baseDir);
      const files = fs.readdirSync(path.join(baseDir, 'tmp-check'));
      expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
      expect(files.sort()).toEqual(
        ['campaign.json', 'character.json', 'chronicle.json', 'world.json'].sort(),
      );
    });

    it('writes each file as a { schemaVersion, data } envelope', () => {
      const state = makeState('envelope-check', 'Envelope Check');
      saveGame(state, baseDir);
      const raw = JSON.parse(
        fs.readFileSync(path.join(baseDir, 'envelope-check', 'character.json'), 'utf8'),
      );
      expect(raw.schemaVersion).toBe(SCHEMA_VERSION);
      expect(raw.data).toEqual(state.character);
    });

    it('throws naming the file and versions when schemaVersion is tampered with', () => {
      const state = makeState('tamper-test', 'Tamper Test');
      saveGame(state, baseDir);
      const campaignFile = path.join(baseDir, 'tamper-test', 'campaign.json');
      const raw = JSON.parse(fs.readFileSync(campaignFile, 'utf8'));
      raw.schemaVersion = 99;
      fs.writeFileSync(campaignFile, JSON.stringify(raw));

      let thrown: unknown;
      try {
        loadGame('tamper-test', baseDir);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain(campaignFile);
      expect(message).toContain('99');
      expect(message).toContain(String(SCHEMA_VERSION));
    });
  });

  describe('schema migration (v1 -> v2)', () => {
    /** Writes a hand-built v1 (pre-luck) save: no Character.luck/background/backgroundFact fields. */
    function writeLegacySave(slug: string, character: Record<string, unknown>): void {
      const dir = path.join(baseDir, slug);
      fs.mkdirSync(dir, { recursive: true });
      const campaign = {
        slug,
        name: 'Legacy Save',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        contentRating: 'PG-13',
      };
      const world = { theme: 'classic fantasy', location: 'Old Town', npcs: [], quests: [], facts: [] };
      const chronicle = { storySoFar: '', chapters: [], lastSummarizedIndex: 0 };
      fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({ schemaVersion: 1, data: campaign }));
      fs.writeFileSync(path.join(dir, 'character.json'), JSON.stringify({ schemaVersion: 1, data: character }));
      fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({ schemaVersion: 1, data: world }));
      fs.writeFileSync(path.join(dir, 'chronicle.json'), JSON.stringify({ schemaVersion: 1, data: chronicle }));
    }

    it('defaults luck to 1 and background/backgroundFact to "" when loading a pre-luck (v1) character save', () => {
      writeLegacySave('legacy-save', {
        name: 'Old Hero',
        className: 'Fighter',
        race: 'Human',
        level: 3,
        xp: 900,
        hp: 20,
        maxHp: 20,
        ac: 16,
        stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
        gold: 50,
        inventory: [{ name: 'Sword', qty: 1 }],
        // no luck / background / backgroundFact -- exactly what a real pre-upgrade save looks like.
      });

      const loaded = loadGame('legacy-save', baseDir);

      expect(loaded.character.luck).toBe(1);
      expect(loaded.character.background).toBe('');
      expect(loaded.character.backgroundFact).toBe('');
      // Everything else from the old save comes through untouched.
      expect(loaded.character.name).toBe('Old Hero');
      expect(loaded.character.level).toBe(3);
      expect(loaded.character.inventory).toEqual([{ name: 'Sword', qty: 1 }]);
    });

    it('does not clobber luck/background if a v1 file somehow already had them (defensive, should not happen in practice)', () => {
      writeLegacySave('legacy-save-with-extras', {
        name: 'Odd Hero',
        className: 'Rogue',
        race: 'Elf',
        level: 1,
        xp: 0,
        hp: 8,
        maxHp: 8,
        ac: 14,
        stats: { str: 8, dex: 16, con: 12, int: 10, wis: 10, cha: 10 },
        gold: 5,
        inventory: [],
        luck: 2,
        background: 'Scholar',
        backgroundFact: 'already set',
      });

      const loaded = loadGame('legacy-save-with-extras', baseDir);

      expect(loaded.character.luck).toBe(2);
      expect(loaded.character.background).toBe('Scholar');
      expect(loaded.character.backgroundFact).toBe('already set');
    });

    it('re-saving a migrated character persists schemaVersion 2 with luck included on disk', () => {
      writeLegacySave('legacy-resave', {
        name: 'Old Hero',
        className: 'Fighter',
        race: 'Human',
        level: 1,
        xp: 0,
        hp: 12,
        maxHp: 12,
        ac: 15,
        stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
        gold: 10,
        inventory: [],
      });

      const loaded = loadGame('legacy-resave', baseDir);
      saveGame(loaded, baseDir);

      const raw = JSON.parse(fs.readFileSync(path.join(baseDir, 'legacy-resave', 'character.json'), 'utf8'));
      expect(raw.schemaVersion).toBe(SCHEMA_VERSION);
      expect(raw.data.luck).toBe(1);
      expect(raw.data.background).toBe('');
    });

    it('still throws for a genuinely newer-than-supported schemaVersion (not silently migrated)', () => {
      writeLegacySave('too-new', { name: 'X' });
      const characterFile = path.join(baseDir, 'too-new', 'character.json');
      const raw = JSON.parse(fs.readFileSync(characterFile, 'utf8'));
      raw.schemaVersion = SCHEMA_VERSION + 1;
      fs.writeFileSync(characterFile, JSON.stringify(raw));

      expect(() => loadGame('too-new', baseDir)).toThrow(String(SCHEMA_VERSION));
    });
  });

  describe('schema migration (v2 -> v3): Quest.reward', () => {
    /** Writes a hand-built v2 (pre-reward) save: quests present but missing the `reward` field. */
    function writeV2Save(slug: string, quests: Array<Record<string, unknown>>): void {
      const dir = path.join(baseDir, slug);
      fs.mkdirSync(dir, { recursive: true });
      const campaign = {
        slug,
        name: 'V2 Save',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        contentRating: 'PG-13',
      };
      const character = {
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
        inventory: [],
        luck: 1,
      };
      const world = { theme: 'classic fantasy', location: 'Old Town', npcs: [], quests, facts: [] };
      const chronicle = { storySoFar: '', chapters: [], lastSummarizedIndex: 0 };
      fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({ schemaVersion: 2, data: campaign }));
      fs.writeFileSync(path.join(dir, 'character.json'), JSON.stringify({ schemaVersion: 2, data: character }));
      fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({ schemaVersion: 2, data: world }));
      fs.writeFileSync(path.join(dir, 'chronicle.json'), JSON.stringify({ schemaVersion: 2, data: chronicle }));
    }

    it('defaults reward to "" for every quest when loading a pre-reward (v2) world save', () => {
      writeV2Save('legacy-v2-quests', [
        { title: 'Find the Amulet', status: 'active', notes: ['Started the search'] },
        { title: 'Slay the Dragon', status: 'completed', notes: [] },
      ]);

      const loaded = loadGame('legacy-v2-quests', baseDir);

      expect(loaded.world.quests).toHaveLength(2);
      expect(loaded.world.quests[0].reward).toBe('');
      expect(loaded.world.quests[1].reward).toBe('');
      // Everything else from the old save comes through untouched.
      expect(loaded.world.quests[0].title).toBe('Find the Amulet');
      expect(loaded.world.quests[0].notes).toEqual(['Started the search']);
    });

    it('does not clobber reward if a v2 file somehow already had it (defensive, should not happen in practice)', () => {
      writeV2Save('legacy-v2-quests-with-reward', [
        { title: 'Odd Quest', status: 'active', notes: [], reward: '≈50 gold' },
      ]);

      const loaded = loadGame('legacy-v2-quests-with-reward', baseDir);
      expect(loaded.world.quests[0].reward).toBe('≈50 gold');
    });

    it('handles an empty quests array without error', () => {
      writeV2Save('legacy-v2-no-quests', []);
      const loaded = loadGame('legacy-v2-no-quests', baseDir);
      expect(loaded.world.quests).toEqual([]);
    });

    it('re-saving a migrated world persists schemaVersion 3 with reward included on disk', () => {
      writeV2Save('legacy-v2-resave', [{ title: 'Find the Amulet', status: 'active', notes: [] }]);
      const loaded = loadGame('legacy-v2-resave', baseDir);
      saveGame(loaded, baseDir);

      const raw = JSON.parse(fs.readFileSync(path.join(baseDir, 'legacy-v2-resave', 'world.json'), 'utf8'));
      expect(raw.schemaVersion).toBe(SCHEMA_VERSION);
      expect(raw.data.quests[0].reward).toBe('');
    });
  });

  describe('listCampaigns / latestCampaign', () => {
    it('lists campaigns newest-updated first and tolerates junk entries', () => {
      const older = makeState('older-campaign', 'Older Campaign');
      saveGame(older, baseDir);
      const newer = makeState('newer-campaign', 'Newer Campaign');
      saveGame(newer, baseDir);

      // Force a deterministic ordering regardless of how fast the two saves ran.
      const olderCampaignFile = path.join(baseDir, 'older-campaign', 'campaign.json');
      const olderRaw = JSON.parse(fs.readFileSync(olderCampaignFile, 'utf8'));
      olderRaw.data.updatedAt = '2020-01-01T00:00:00.000Z';
      fs.writeFileSync(olderCampaignFile, JSON.stringify(olderRaw));

      const newerCampaignFile = path.join(baseDir, 'newer-campaign', 'campaign.json');
      const newerRaw = JSON.parse(fs.readFileSync(newerCampaignFile, 'utf8'));
      newerRaw.data.updatedAt = '2023-01-01T00:00:00.000Z';
      fs.writeFileSync(newerCampaignFile, JSON.stringify(newerRaw));

      // Junk: a stray file and an empty directory alongside real campaign dirs.
      fs.writeFileSync(path.join(baseDir, 'random.txt'), 'not a campaign');
      fs.mkdirSync(path.join(baseDir, 'empty-dir'), { recursive: true });

      const listings = listCampaigns(baseDir);
      expect(listings.map((l) => l.slug)).toEqual(['newer-campaign', 'older-campaign']);

      const latest = latestCampaign(baseDir);
      expect(latest?.slug).toBe('newer-campaign');
    });

    it('returns an empty list and null latest when baseDir does not exist', () => {
      const missingDir = path.join(baseDir, 'does-not-exist');
      expect(listCampaigns(missingDir)).toEqual([]);
      expect(latestCampaign(missingDir)).toBeNull();
    });

    it('summarises the hero and location so the picker can show who you left off as', () => {
      const state = makeState('with-hero', 'With Hero');
      state.character.hp = 7;
      state.world.location = 'The Rusty Anchor';
      saveGame(state, baseDir);

      const [listing] = listCampaigns(baseDir);
      expect(listing.hero).toEqual({
        name: 'Hero',
        race: 'Human',
        className: 'Fighter',
        level: 1,
        hp: 7,
        maxHp: state.character.maxHp,
        location: 'The Rusty Anchor',
      });
    });

    it('still lists a campaign whose character/world files are missing or corrupt, just without a hero', () => {
      const readable = makeState('readable', 'Readable');
      saveGame(readable, baseDir);

      const corrupt = makeState('corrupt-hero', 'Corrupt Hero');
      saveGame(corrupt, baseDir);
      fs.writeFileSync(path.join(baseDir, 'corrupt-hero', 'character.json'), '{ not json');

      const missing = makeState('missing-hero', 'Missing Hero');
      saveGame(missing, baseDir);
      fs.rmSync(path.join(baseDir, 'missing-hero', 'world.json'));

      const bySlug = new Map(listCampaigns(baseDir).map((l) => [l.slug, l]));
      // The whole point: a broken hero file degrades the card, it does not
      // remove the campaign from the picker or make it unresumable.
      expect([...bySlug.keys()].sort()).toEqual(['corrupt-hero', 'missing-hero', 'readable']);
      expect(bySlug.get('corrupt-hero')?.hero).toBeUndefined();
      expect(bySlug.get('missing-hero')?.hero).toBeUndefined();
      expect(bySlug.get('readable')?.hero?.name).toBe('Hero');
    });
  });

  describe('transcript', () => {
    it('round-trips entries via append and read, in order', () => {
      appendTranscript(
        'transcript-test',
        { role: 'player', text: 'I open the door.', ts: '2024-01-01T00:00:00.000Z' },
        baseDir,
      );
      appendTranscript(
        'transcript-test',
        { role: 'dm', text: 'The door creaks open.', ts: '2024-01-01T00:00:01.000Z' },
        baseDir,
      );

      const entries = readTranscript('transcript-test', baseDir);
      expect(entries).toEqual([
        { role: 'player', text: 'I open the door.', ts: '2024-01-01T00:00:00.000Z' },
        { role: 'dm', text: 'The door creaks open.', ts: '2024-01-01T00:00:01.000Z' },
      ]);
    });

    it('returns an empty array when the transcript file does not exist', () => {
      expect(readTranscript('never-played', baseDir)).toEqual([]);
    });

    it('skips corrupt lines but keeps valid ones', () => {
      const dir = path.join(baseDir, 'corrupt-transcript');
      fs.mkdirSync(dir, { recursive: true });
      const goodLine = JSON.stringify({
        role: 'system',
        text: 'Game started.',
        ts: '2024-01-01T00:00:00.000Z',
      });
      fs.writeFileSync(
        path.join(dir, 'transcript.jsonl'),
        `${goodLine}\nnot valid json\n{"role":"player"}\n`,
      );

      const entries = readTranscript('corrupt-transcript', baseDir);
      expect(entries).toEqual([
        { role: 'system', text: 'Game started.', ts: '2024-01-01T00:00:00.000Z' },
      ]);
    });
  });
});

describe('savePaths containment (multiplayer isolation)', () => {
  // Per-player isolation works by scoping baseDir to the player's own folder,
  // so a slug that escapes that folder escapes the isolation. path.join
  // normalises "../alice/secret" straight into a sibling player's campaign;
  // this was verified exploitable before the guard existed.
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-containment-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses a slug that resolves outside its own save directory", () => {
    const alice = path.join(root, 'alice');
    const bob = path.join(root, 'bob');
    fs.mkdirSync(alice, { recursive: true });
    fs.mkdirSync(bob, { recursive: true });
    saveGame(makeState('secret', 'Alice Secret'), alice);

    for (const slug of ['../alice/secret', '../../etc/passwd', 'x/../../alice/secret', '', '.', '/etc']) {
      expect(() => loadGame(slug, bob)).toThrow(/Invalid campaign slug|outside/);
    }
  });

  it('still allows a legitimate slug in the same directory', () => {
    const bob = path.join(root, 'bob');
    fs.mkdirSync(bob, { recursive: true });
    saveGame(makeState('bobs-own', "Bob's Own"), bob);
    expect(loadGame('bobs-own', bob).campaign.slug).toBe('bobs-own');
  });

  it('deleteCampaign is protected by the same check', () => {
    const alice = path.join(root, 'alice');
    const bob = path.join(root, 'bob');
    fs.mkdirSync(alice, { recursive: true });
    fs.mkdirSync(bob, { recursive: true });
    saveGame(makeState('precious', 'Alice Precious'), alice);

    expect(() => deleteCampaign('../alice/precious', bob)).toThrow(/Invalid campaign slug|outside/);
    expect(fs.existsSync(path.join(alice, 'precious', 'campaign.json'))).toBe(true);
  });

  it('deleteCampaign retires a campaign into .deleted, recoverably', () => {
    const dir = path.join(root, 'solo');
    fs.mkdirSync(dir, { recursive: true });
    saveGame(makeState('bin-me', 'Bin Me'), dir);

    const moved = deleteCampaign('bin-me', dir);
    expect(fs.existsSync(path.join(dir, 'bin-me'))).toBe(false);
    expect(fs.existsSync(path.join(moved, 'campaign.json'))).toBe(true);
    expect(listCampaigns(dir)).toEqual([]);
  });
});
