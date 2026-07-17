import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  slugify,
  saveGame,
  loadGame,
  listCampaigns,
  latestCampaign,
  appendTranscript,
  readTranscript,
} from '../src/game/saves';
import type { GameState } from '../src/game/state';
import { SCHEMA_VERSION } from '../src/game/state';

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
      level: 1,
      xp: 0,
      hp: 12,
      maxHp: 12,
      ac: 15,
      stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
      gold: 10,
      inventory: [{ name: 'Rope', qty: 1 }],
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
