import { describe, it, expect } from 'vitest';
import { DICE_AREA_HEIGHT, INPUT_BAR_HEIGHT, computeStoryHeight } from '../../src/ui/layout';

const MIN_ROWS = 20; // mirrors App.tsx's MIN_ROWS -- below this the app shows a warning instead of this layout.

describe('layout: dice card is a fixed 3-row card (bug fix: numbers were getting truncated off a 2-row layout)', () => {
  it('DICE_AREA_HEIGHT is exactly 3', () => {
    expect(DICE_AREA_HEIGHT).toBe(3);
  });
});

describe('computeStoryHeight', () => {
  it('never leaves the frame taller or shorter than `rows`: storyHeight + DICE_AREA_HEIGHT + INPUT_BAR_HEIGHT === rows', () => {
    for (let rows = MIN_ROWS; rows <= MIN_ROWS + 200; rows++) {
      const storyHeight = computeStoryHeight(rows);
      expect(storyHeight + DICE_AREA_HEIGHT + INPUT_BAR_HEIGHT).toBe(rows);
    }
  });

  it('is exact at the minimum supported terminal size', () => {
    expect(computeStoryHeight(MIN_ROWS)).toBe(MIN_ROWS - DICE_AREA_HEIGHT - INPUT_BAR_HEIGHT);
    expect(computeStoryHeight(MIN_ROWS)).toBe(14);
  });

  it('never returns less than 1, even for a pathologically small row count', () => {
    expect(computeStoryHeight(0)).toBe(1);
    expect(computeStoryHeight(DICE_AREA_HEIGHT + INPUT_BAR_HEIGHT)).toBe(1);
  });

  it('grows linearly with rows once past the floor', () => {
    expect(computeStoryHeight(30)).toBe(computeStoryHeight(29) + 1);
    expect(computeStoryHeight(100) - computeStoryHeight(50)).toBe(50);
  });
});
