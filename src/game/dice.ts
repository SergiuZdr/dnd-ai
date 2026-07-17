// Dice expression parsing + rolling. Pure functions, no game state.

export interface ParsedDice {
  count: number;
  sides: number;
  modifier: number;
}

export type RollMode = 'normal' | 'advantage' | 'disadvantage';

export interface RollResult {
  expr: string;
  mode: RollMode;
  /** One inner array per attempt (2 attempts for adv/dis, 1 for normal): the individual die faces. */
  attempts: number[][];
  modifier: number;
  /** The die faces of the attempt that was kept. */
  chosen: number[];
  /** sum(chosen) + modifier */
  total: number;
}

// Grammar (case-insensitive, whitespace-tolerant): [N]d<S>[+M|-M]
const DICE_PATTERN = /^\s*(\d+)?\s*d\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/i;

const MIN_COUNT = 1;
const MAX_COUNT = 100;
const MIN_SIDES = 2;
const MAX_SIDES = 1000;
const MIN_MODIFIER = -1000;
const MAX_MODIFIER = 1000;

export function parseDice(expr: string): ParsedDice | null {
  const match = DICE_PATTERN.exec(expr);
  if (!match) return null;

  const [, countGroup, sidesGroup, sign, modifierGroup] = match;

  const count = countGroup === undefined ? 1 : Number(countGroup);
  const sides = Number(sidesGroup);
  let modifier = 0;
  if (sign !== undefined && modifierGroup !== undefined) {
    const magnitude = Number(modifierGroup);
    modifier = sign === '-' ? -magnitude : magnitude;
  }

  if (!Number.isInteger(count) || count < MIN_COUNT || count > MAX_COUNT) return null;
  if (!Number.isInteger(sides) || sides < MIN_SIDES || sides > MAX_SIDES) return null;
  if (!Number.isInteger(modifier) || modifier < MIN_MODIFIER || modifier > MAX_MODIFIER) return null;

  return { count, sides, modifier };
}

function sum(faces: number[]): number {
  return faces.reduce((total, face) => total + face, 0);
}

export function roll(
  expr: string,
  mode: RollMode = 'normal',
  rng: () => number = Math.random,
): RollResult {
  const parsed = parseDice(expr);
  if (!parsed) {
    throw new Error(`Invalid dice expression: ${expr}`);
  }
  const { count, sides, modifier } = parsed;
  const attemptCount = mode === 'normal' ? 1 : 2;

  const attempts: number[][] = [];
  for (let a = 0; a < attemptCount; a++) {
    const faces: number[] = [];
    for (let i = 0; i < count; i++) {
      faces.push(Math.floor(rng() * sides) + 1);
    }
    attempts.push(faces);
  }

  let chosen: number[];
  if (mode === 'normal') {
    chosen = attempts[0];
  } else if (mode === 'advantage') {
    chosen = sum(attempts[0]) >= sum(attempts[1]) ? attempts[0] : attempts[1];
  } else {
    chosen = sum(attempts[0]) <= sum(attempts[1]) ? attempts[0] : attempts[1];
  }

  const total = sum(chosen) + modifier;

  return { expr, mode, attempts, modifier, chosen, total };
}
