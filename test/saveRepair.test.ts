// Tests for the two save-repair utilities' pure cores:
//   scripts/fix-item-names.ts  -- repairInventory()
//   scripts/rewind.ts          -- cutIndexForTurns()
// Both scripts guard their own main() behind an isDirectRun check, so importing
// them here runs no I/O and parses no argv.

import { describe, it, expect } from 'vitest';
import { repairInventory } from '../scripts/fix-item-names';
import { cutIndexForTurns } from '../scripts/rewind';

describe('repairInventory', () => {
  it('moves a count baked into the name into qty, so the item can be spent one at a time', () => {
    const { inventory, changes } = repairInventory([
      { name: 'Staff', qty: 1 },
      { name: "Aldric's Tinctures & Extracts (5 bottles)", qty: 1 },
    ]);
    expect(inventory).toEqual([
      { name: 'Staff', qty: 1 },
      { name: "Aldric's tincture", qty: 5 },
    ]);
    expect(changes).toHaveLength(1);
  });

  it('leaves descriptive parentheticals alone — they are not counts', () => {
    // The exact trap a generic "number in parens" regex would fall into.
    const before = [
      { name: 'Rope (50 feet)', qty: 1 },
      { name: 'Provisions bundle (bread, preserved meat)', qty: 1 },
      { name: 'Water skins (filled)', qty: 1 },
    ];
    const { inventory, changes } = repairInventory(before);
    expect(inventory).toEqual(before);
    expect(changes).toEqual([]);
  });

  it('is idempotent — a second pass over repaired data changes nothing', () => {
    const once = repairInventory([{ name: 'Alchemical vials (2)', qty: 1 }]).inventory;
    const twice = repairInventory(once);
    expect(twice.inventory).toEqual(once);
    expect(twice.changes).toEqual([]);
  });

  it('merges into an existing correctly-named entry rather than creating a duplicate', () => {
    // Two entries with the same name would break removeItem, whose findIndex
    // only ever sees the first one.
    const { inventory } = repairInventory([
      { name: "Aldric's tincture", qty: 2 },
      { name: "Aldric's Tinctures & Extracts (5 bottles)", qty: 1 },
    ]);
    expect(inventory).toEqual([{ name: "Aldric's tincture", qty: 7 }]);
  });

  it('multiplies out stacked copies of a baked-count item', () => {
    const { inventory } = repairInventory([{ name: 'Alchemical vials (2)', qty: 3 }]);
    expect(inventory).toEqual([{ name: 'Alchemical vial', qty: 6 }]);
  });

  it('matches names case-insensitively, the way engine.removeItem does', () => {
    const { inventory } = repairInventory([{ name: "aldric's tinctures & extracts (5 BOTTLES)", qty: 1 }]);
    expect(inventory).toEqual([{ name: "Aldric's tincture", qty: 5 }]);
  });
});

describe('cutIndexForTurns', () => {
  const t = (role: 'player' | 'dm' | 'system', text: string) => ({ role, text, ts: '2024-01-01T00:00:00.000Z' });

  it('cuts at the Nth-from-last player entry, dropping it and everything after', () => {
    const entries = [
      t('player', 'p1'), t('dm', 'd1'),
      t('player', 'p2'), t('dm', 'd2'),
      t('player', 'p3'), t('dm', 'd3'),
    ];
    // Rewind 2 turns -> keep p1/d1, drop from p2 onward.
    expect(cutIndexForTurns(entries, 2)).toBe(2);
    expect(entries.slice(0, 2).map((e) => e.text)).toEqual(['p1', 'd1']);
  });

  it('keeps system entries that belong to a kept turn and drops those after the cut', () => {
    const entries = [
      t('player', 'p1'), t('system', 'roll'), t('dm', 'd1'),
      t('player', 'p2'), t('system', 'damage'), t('dm', 'd2'),
    ];
    const cut = cutIndexForTurns(entries, 1);
    expect(cut).toBe(3);
    expect(entries.slice(cut).map((e) => e.role)).toEqual(['player', 'system', 'dm']);
  });

  it('returns 0 when asked to rewind further back than the campaign goes', () => {
    const entries = [t('player', 'p1'), t('dm', 'd1')];
    expect(cutIndexForTurns(entries, 5)).toBe(0);
    expect(cutIndexForTurns(entries, 1)).toBe(0);
  });

  it('handles an empty transcript', () => {
    expect(cutIndexForTurns([], 5)).toBe(0);
  });
});
