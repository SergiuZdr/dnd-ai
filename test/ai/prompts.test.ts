import { describe, it, expect } from 'vitest';
import {
  dmSystemPrompt,
  buildOpeningPrompt,
  buildNewHeroPrompt,
  buildContextBrief,
  withMechanicsReminder,
  narratorSystemPrompt,
  refereeSystemPrompt,
} from '../../src/ai/prompts';
import { splitSuggestions } from '../../src/ai/suggestions';
import type { GameState } from '../../src/game/state';
import type { TranscriptEntry } from '../../src/game/saves';

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

/**
 * The suggested-actions trailer is the ONE sanctioned exception to the
 * no-choice-menus rule. Both halves have to hold at once: the trailer must be
 * asked for, AND the prose must still be forbidden from enumerating options --
 * models will happily restate the three suggestions as an A/B/C list in the
 * narration if the prompt does not keep saying not to.
 */
describe('suggested-actions trailer contract', () => {
  const playerFacing = [
    ['dmSystemPrompt', dmSystemPrompt('PG-13')],
    ['narratorSystemPrompt', narratorSystemPrompt('PG-13')],
  ] as const;

  for (const [name, prompt] of playerFacing) {
    it(name + ' asks for the trailer in the exact format suggestions.ts parses', () => {
      expect(prompt).toContain('[[SUGGEST:');
      // The documented example must actually round-trip through the parser.
      const match = /\[\[SUGGEST:[^\]]*\]\]/.exec(prompt);
      expect(match).not.toBeNull();
      const { suggestions } = splitSuggestions('Some prose.\n' + match![0]);
      expect(suggestions).toHaveLength(3);
    });

    it(name + ' still forbids choice menus inside the prose', () => {
      expect(prompt).toContain('No choice menus');
      expect(prompt).toMatch(/never appear in your narration|never a replacement for it|not license a choice menu/i);
    });

    it(name + ' requires the trailer to come last so streaming can cut it off', () => {
      expect(prompt).toMatch(/last (line|thing)|final line/i);
    });
  }

  // The referee never writes anything the player reads, so a trailer there
  // would be dead weight the narrator would have to ignore.
  it('does not ask the referee for a trailer', () => {
    expect(refereeSystemPrompt('PG-13')).not.toContain('[[SUGGEST');
  });

  it('withMechanicsReminder repeats the trailer ask, because small models obey the last message', () => {
    const wire = withMechanicsReminder('I open the door.', makeState());
    expect(wire).toContain('[[SUGGEST:');
  });
});

/**
 * Each assertion here corresponds to a defect seen in a live 10-turn playtest
 * on free models -- these are the rules that keep weak referees/narrators
 * mechanically honest, so a refactor that quietly drops one should fail.
 */
describe('playtest-driven mechanics guardrails', () => {
  const toolOwners = [
    ['dmSystemPrompt', dmSystemPrompt('PG-13')],
    ['refereeSystemPrompt', refereeSystemPrompt('PG-13')],
  ] as const;

  for (const [name, prompt] of toolOwners) {
    it(name + ' demands damage be applied in the same turn it is rolled', () => {
      expect(prompt).toContain('apply_damage');
      expect(prompt).toMatch(/same turn|NOW, in this same turn|not next turn/i);
    });

    it(name + ' demands XP and quests actually get recorded', () => {
      expect(prompt).toContain('award_xp');
      expect(prompt).toContain('upsert_quest');
    });

    it(name + ' forbids rolling for trivial actions', () => {
      expect(prompt).toMatch(/cannot interestingly fail|Do NOT call roll_dice/i);
      expect(prompt).toMatch(/unlocked door/i);
    });

    it(name + " keeps an enemy's own roll off the player's dice tray", () => {
      expect(prompt).toMatch(/roller:.dm./);
      expect(prompt).toMatch(/never roller:.player.|Never hand the player a die/i);
    });
  }

  it('the narrator is forbidden from escalating the hero past their Condition', () => {
    const prompt = narratorSystemPrompt('PG-13');
    expect(prompt).toMatch(/NEVER ESCALATE/i);
    expect(prompt).toMatch(/collaps|black(ing)? out|dying/i);
    expect(prompt).toMatch(/MISSED/);
  });

  it('suggestions may not reference items the hero lacks', () => {
    for (const prompt of [dmSystemPrompt('PG-13'), narratorSystemPrompt('PG-13')]) {
      expect(prompt).toMatch(/do not have|not have|carrying/i);
    }
  });

  it('withMechanicsReminder repeats the checklist, since small models obey the last message', () => {
    const wire = withMechanicsReminder('I swing at the bandit.', makeState());
    expect(wire).toContain('apply_damage');
    expect(wire).toContain('defeat_foe');
    expect(wire).toContain('upsert_quest');
    expect(wire).toMatch(/roller:.dm./);
  });

  // A second live playtest, after the first round of fixes landed: the referee
  // read "I pocket the ten gold pieces" as modify_gold(-10) and left the hero
  // poorer for looting; the narrator handed over a pouch, a dagger and a map
  // that no tool ever recorded, on a roll it had just been told was a FAILURE;
  // and a won fight still ended at 0 XP.
  for (const [name, prompt] of toolOwners) {
    it(name + ' names the gold direction in the tool, never in a sign', () => {
      expect(prompt).toContain('award_gold');
      expect(prompt).toContain('spend_gold');
      expect(prompt).not.toContain('modify_gold');
      expect(prompt).toMatch(/RICHER/);
    });

    it(name + ' routes a defeated foe through the tool that also pays the XP', () => {
      expect(prompt).toContain('defeat_foe');
      expect(prompt).toMatch(/XP still at 0 is a mistake|must never end without this call/i);
    });

    it(name + ' will not make the player roll to keep loot they already found', () => {
      expect(prompt).toMatch(/PICKING THINGS UP IS NOT A CHECK/i);
      expect(prompt).toMatch(/already found|already searched|already earned/i);
    });
  }

  it('the narrator may not invent a reward the ledger does not have', () => {
    const prompt = narratorSystemPrompt('PG-13');
    expect(prompt).toMatch(/NEVER INVENT A REWARD/i);
    expect(prompt).toMatch(/did not get it/i);
  });

  it('the narrator must let a failed roll read as a failure', () => {
    const prompt = narratorSystemPrompt('PG-13');
    expect(prompt).toMatch(/OBEY THE ROLL/i);
    expect(prompt).toMatch(/FAILED check must read as a failure/i);
    expect(prompt).toMatch(/Never describe a success and a failure of the same attempt/i);
  });
});
