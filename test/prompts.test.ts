import { describe, it, expect } from 'vitest';
import { dmSystemPrompt, buildOpeningPrompt, buildNewHeroPrompt, buildContextBrief, withMechanicsReminder } from '../src/ai/prompts';
import type { GameState } from '../src/game/state';
import type { TranscriptEntry } from '../src/game/saves';

function makeState(overrides?: Partial<GameState['character']>): GameState {
  return {
    campaign: {
      slug: 'prompt-test',
      name: 'Prompt Test',
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
      inventory: [],
      luck: 1,
      ...overrides,
    },
    world: { theme: 'classic fantasy', location: 'Starting Village', npcs: [], quests: [], facts: [] },
    chronicle: { storySoFar: '', chapters: [], lastSummarizedIndex: 0 },
  };
}

function tEntry(role: TranscriptEntry['role'], text: string): TranscriptEntry {
  return { role, text, ts: '2024-01-01T00:00:00.000Z' };
}

describe('dmSystemPrompt', () => {
  it('states the narration-length rule: default short, dramatic peaks only exception, never recap', () => {
    const prompt = dmSystemPrompt('PG-13');
    expect(prompt).toMatch(/1-2 short paragraphs/);
    expect(prompt).toContain('60-120 words');
    expect(prompt).toMatch(/dramatic peaks/);
    expect(prompt).toMatch(/[Nn]ever recap what the player just said/);
  });

  it('instructs a short 3-6 word roll_dice reason, never a full sentence (bug fix: long reasons pushed the roll result off screen)', () => {
    const prompt = dmSystemPrompt('PG-13');
    expect(prompt).toContain('3-6 words');
    expect(prompt).toMatch(/never a full sentence/);
  });

  it('gives DC guidance with the full trivial/easy/medium/hard/very-hard scale and roller:player/dm split', () => {
    const prompt = dmSystemPrompt('PG-13');
    expect(prompt).toContain('5 trivial');
    expect(prompt).toContain('8 easy');
    expect(prompt).toContain('12 medium');
    expect(prompt).toContain('15 hard');
    expect(prompt).toContain('18 very hard');
    expect(prompt).toContain("roller:'player'");
    expect(prompt).toContain("roller:'dm'");
    expect(prompt).toMatch(/target's effective defense/);
  });

  it('explains luck rerolls so the DM can narrate them in-fiction', () => {
    const prompt = dmSystemPrompt('PG-13');
    expect(prompt.toLowerCase()).toContain('luck');
    expect(prompt.toLowerCase()).toMatch(/fate|fortune/);
  });

  it('still carries the content-rating line for both ratings', () => {
    expect(dmSystemPrompt('PG-13')).toContain('Content rating: PG-13');
    expect(dmSystemPrompt('R')).toContain('Content rating: R');
  });

  it('R rating permits mature romance with an in-fiction fade to black and forbids out-of-character content lectures', () => {
    const prompt = dmSystemPrompt('R');
    expect(prompt).toContain('fade to black');
    expect(prompt).toContain('NEVER break character');
    expect(prompt).toMatch(/brutal and graphic/);
    expect(prompt).not.toContain('still no sexual content');
    // PG-13 keeps its stricter line untouched.
    expect(dmSystemPrompt('PG-13')).toContain('no explicit gore, sexual content, or profanity');
  });

  it('pushes the DM to spread DCs across the whole range and to put stat modifiers in expr', () => {
    const prompt = dmSystemPrompt('PG-13');
    expect(prompt).toContain('Use the WHOLE dc range');
    expect(prompt).toContain('ability modifier in expr');
    expect(prompt).toContain('"d20-1"');
  });

  it('tells the DM to drive the action and demand rolls itself, not just wait for the player', () => {
    const prompt = dmSystemPrompt('PG-13');
    expect(prompt).toContain('Rolls flow both ways');
    expect(prompt).toContain('Drive the action');
  });
});

describe('hero sheet line (precomputed modifiers)', () => {
  const sheetStats = { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 8 };

  it('buildOpeningPrompt carries precomputed ability modifiers so a fresh DM never has to ask for stats', () => {
    const prompt = buildOpeningPrompt(makeState({ stats: sheetStats }));
    expect(prompt).toContain('STR+3');
    expect(prompt).toContain('DEX+1');
    expect(prompt).toContain('CHA-1');
    expect(prompt).toMatch(/HP \d+\/\d+, AC \d+, luck \d+/);
  });

  it('withMechanicsReminder carries the current sheet each turn (mods, HP, AC, luck)', () => {
    const state = makeState({ stats: sheetStats });
    state.character.hp = 5;
    state.character.maxHp = 12;
    const wire = withMechanicsReminder('I kick the door.', state);
    expect(wire.startsWith('I kick the door.')).toBe(true);
    expect(wire).toContain('STR+3');
    expect(wire).toContain('HP 5/12');
    expect(wire.endsWith('</system-reminder>')).toBe(true);
  });
});

describe('buildOpeningPrompt / buildNewHeroPrompt', () => {
  it('weaves the background name + fact into the opening prompt when one was chosen', () => {
    const state = makeState({ background: 'Soldier', backgroundFact: 'served as a soldier before adventuring' });
    const prompt = buildOpeningPrompt(state);
    expect(prompt).toContain('Soldier');
    expect(prompt).toContain('served as a soldier before adventuring');
  });

  it('omits any background clause when none was chosen', () => {
    const state = makeState({ background: '', backgroundFact: '' });
    const prompt = buildOpeningPrompt(state);
    expect(prompt).not.toContain('Background:');
  });

  it('weaves the background into the new-hero (/retire) prompt too', () => {
    const state = makeState({ background: 'Scholar', backgroundFact: 'knows a lore hook' });
    const prompt = buildNewHeroPrompt(state);
    expect(prompt).toContain('Scholar');
    expect(prompt).toContain('knows a lore hook');
  });
});

describe('buildContextBrief verbatim window', () => {
  it('keeps at most 10 recent transcript lines (player+dm) by default, even when well under the char budget', () => {
    const state = makeState();
    const transcript: TranscriptEntry[] = [];
    for (let i = 0; i < 20; i++) {
      transcript.push(tEntry('player', `action ${i}`));
      transcript.push(tEntry('dm', `narration ${i}`));
    }
    const brief = buildContextBrief(state, transcript);
    // 40 total lines (20 player + 20 dm); the default cap of 10 keeps only
    // the last 10 individual lines -- action/narration 15 through 19.
    expect(brief).not.toContain('action 14');
    expect(brief).toContain('action 15');
    expect(brief).toContain('narration 19');
  });

  it('honors an explicit maxVerbatimExchanges override', () => {
    const state = makeState();
    const transcript: TranscriptEntry[] = [];
    for (let i = 0; i < 5; i++) {
      transcript.push(tEntry('player', `action ${i}`));
    }
    const brief = buildContextBrief(state, transcript, { maxVerbatimExchanges: 2 });
    expect(brief).not.toContain('action 2');
    expect(brief).toContain('action 3');
    expect(brief).toContain('action 4');
  });

  it('always keeps at least the single most recent entry even if it alone exceeds the char budget', () => {
    const state = makeState();
    const transcript: TranscriptEntry[] = [tEntry('player', 'x'.repeat(500))];
    const brief = buildContextBrief(state, transcript, { maxVerbatimChars: 10, maxVerbatimExchanges: 10 });
    expect(brief).toContain('x'.repeat(500));
  });
});

/**
 * Bug fix: the old closing line ("Resume the scene... do not re-summarize
 * events... end with What do you do?") combined with a blank story log (now
 * fixed separately via GameController's onHistoryReplay) gave the DM every
 * incentive to re-narrate the scene the player already read. The brief now
 * explicitly forbids restating/recapping/re-narrating anything above, and
 * forbids repeating the same beat twice within one reply.
 */
describe('buildContextBrief closing instruction (anti-restatement)', () => {
  it('tells the DM not to restate, recap, paraphrase, or re-narrate what the player already read', () => {
    const brief = buildContextBrief(makeState(), []);
    expect(brief.toLowerCase()).toMatch(/do not restate|do not recap|never restate/);
    expect(brief.toLowerCase()).toContain('already read');
  });

  it('explicitly forbids repeating the same paragraph or beat twice within the reply', () => {
    const brief = buildContextBrief(makeState(), []);
    expect(brief.toLowerCase()).toMatch(/repeat the same (paragraph|beat)/);
  });

  it('still ends with the "What do you do?" hook in the DM voice', () => {
    const brief = buildContextBrief(makeState(), []);
    expect(brief).toContain('Continue in your DM voice');
    expect(brief.endsWith('"What do you do?"')).toBe(true);
  });

  it('no longer contains the old "do not re-summarize events" phrasing', () => {
    const brief = buildContextBrief(makeState(), []);
    expect(brief).not.toContain('do not re-summarize events');
  });
});
