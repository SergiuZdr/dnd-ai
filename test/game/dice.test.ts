import { describe, it, expect } from 'vitest';
import { parseDice, roll } from '../../src/game/dice';

function sequenceRng(values: number[]): () => number {
  let i = 0;
  return () => {
    const value = i < values.length ? values[i] : values[values.length - 1];
    i += 1;
    return value;
  };
}

describe('parseDice', () => {
  const validCases: Array<[string, { count: number; sides: number; modifier: number }]> = [
    ['d20', { count: 1, sides: 20, modifier: 0 }],
    ['2d6+3', { count: 2, sides: 6, modifier: 3 }],
    [' D8 - 1 ', { count: 1, sides: 8, modifier: -1 }],
    ['100d1000', { count: 100, sides: 1000, modifier: 0 }],
  ];

  it.each(validCases)('parses %s', (expr, expected) => {
    expect(parseDice(expr)).toEqual(expected);
  });

  const invalidCases = ['', 'd1', '0d6', '101d6', '2d6+2000', 'abc', 'd20+', '-d20'];

  it.each(invalidCases)('rejects %j as invalid', (expr) => {
    expect(parseDice(expr)).toBeNull();
  });
});

describe('roll', () => {
  it('applies a positive modifier with a stubbed rng', () => {
    const rng = sequenceRng([0.65]); // floor(0.65*20)+1 = 14
    const result = roll('d20+2', 'normal', rng);
    expect(result.attempts).toEqual([[14]]);
    expect(result.chosen).toEqual([14]);
    expect(result.modifier).toBe(2);
    expect(result.total).toBe(16);
    expect(result.mode).toBe('normal');
    expect(result.expr).toBe('d20+2');
  });

  it('sums multiple dice plus a modifier', () => {
    const rng = sequenceRng([0, 0.5]); // face 1, face 4 on a d6
    const result = roll('2d6+3', 'normal', rng);
    expect(result.attempts).toEqual([[1, 4]]);
    expect(result.chosen).toEqual([1, 4]);
    expect(result.total).toBe(8);
  });

  it('applies a negative modifier', () => {
    const rng = sequenceRng([0]); // face 1 on a d8
    const result = roll('1d8-1', 'normal', rng);
    expect(result.total).toBe(0);
  });

  it('defaults to normal mode and Math.random when omitted', () => {
    const result = roll('d20');
    expect(result.mode).toBe('normal');
    expect(result.attempts).toHaveLength(1);
  });

  it('advantage keeps the higher attempt and records both', () => {
    const rng = sequenceRng([0.65, 0.1]); // 14 then 3
    const result = roll('d20', 'advantage', rng);
    expect(result.attempts).toEqual([[14], [3]]);
    expect(result.chosen).toEqual([14]);
    expect(result.total).toBe(14);
  });

  it('disadvantage keeps the lower attempt and records both', () => {
    const rng = sequenceRng([0.65, 0.1]); // 14 then 3
    const result = roll('d20', 'disadvantage', rng);
    expect(result.attempts).toEqual([[14], [3]]);
    expect(result.chosen).toEqual([3]);
    expect(result.total).toBe(3);
  });

  it('breaks ties by keeping the first attempt for both advantage and disadvantage', () => {
    // Both attempts roll the same face (0.5 -> face 11 on a d20), so the sums tie.
    const advantage = roll('d20', 'advantage', sequenceRng([0.5, 0.5]));
    const disadvantage = roll('d20', 'disadvantage', sequenceRng([0.5, 0.5]));
    expect(advantage.chosen).toEqual(advantage.attempts[0]);
    expect(disadvantage.chosen).toEqual(disadvantage.attempts[0]);
  });

  it('throws a descriptive error on an invalid expression', () => {
    expect(() => roll('nonsense')).toThrow('Invalid dice expression: nonsense');
  });

  it('stays within [1,6] across 200 real-rng rolls of d6', () => {
    for (let i = 0; i < 200; i++) {
      const result = roll('d6');
      expect(Number.isInteger(result.total)).toBe(true);
      expect(result.total).toBeGreaterThanOrEqual(1);
      expect(result.total).toBeLessThanOrEqual(6);
    }
  });
});
