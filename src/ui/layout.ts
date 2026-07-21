// Pure layout constants + math for App.tsx's frame-height budgeting.
// Separated from App.tsx (a .tsx file with ink/react imports) purely so
// tests can import the arithmetic without pulling in any UI machinery.

/** Rows for the dice card (idle flourish / interactive roll prompt -- see DiceLine.tsx's row layout) below the story log. */
export const DICE_AREA_HEIGHT = 3;
/** Rows for InputBar's bordered box (top border + content + bottom border). */
export const INPUT_BAR_HEIGHT = 3;

/**
 * The story log's exact viewport height for a given terminal row count.
 * storyHeight + DICE_AREA_HEIGHT + INPUT_BAR_HEIGHT must always equal
 * `rows` exactly -- the whole-frame-height invariant that keeps the UI from
 * ever spilling into terminal scrollback. Below MIN_ROWS the app shows the
 * "too small" warning instead, so the Math.max(1, ...) floor here only
 * matters as a defensive fallback.
 */
export function computeStoryHeight(rows: number): number {
  return Math.max(1, rows - DICE_AREA_HEIGHT - INPUT_BAR_HEIGHT);
}
