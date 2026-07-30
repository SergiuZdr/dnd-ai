// Repairs inventory entries whose COUNT was baked into the item NAME instead
// of the qty field -- e.g. `{ name: "Aldric's Tinctures & Extracts (5 bottles)",
// qty: 1 }` should have been `{ name: "Aldric's tincture", qty: 5 }`.
//
// Why this matters: engine.removeItem() matches on the exact (case-insensitive)
// name and decrements qty. With the count in the name and qty:1, drinking ONE
// tincture either wipes the whole stack of five (qty 1 - 1 = 0, entry spliced)
// or fails outright with "inventory has none" if the DM says "a tincture". So a
// consumable stored this way can never be spent one at a time. ai/tools.ts's
// add_item description and the referee/DM system prompts now forbid creating
// them, but saves written before that still carry them -- hence this.
//
// Usage (dry run prints a diff and writes nothing):
//   npx tsx scripts/admin/fix-item-names.ts
//   npx tsx scripts/admin/fix-item-names.ts --apply
//   npx tsx scripts/admin/fix-item-names.ts --apply --saves-dir /opt/dnd/saves
//   npx tsx scripts/admin/fix-item-names.ts --apply --slug "1st and best world"
//
// --saves-dir must be the directory campaign folders sit DIRECTLY inside: this
// scans <savesDir>/<slug>/character.json one level down. Once players are
// registered, campaigns move under players/<id>/ (see scripts/admin/players.ts),
// so point it there and run it once per player:
//   --saves-dir /opt/dnd/saves/players/sergiu
//
// --apply writes a timestamped .bak of every file it touches first, and the
// script is idempotent: re-running it after a successful pass is a no-op.

import * as fs from 'node:fs';
import * as path from 'node:path';

interface Item {
  name: string;
  qty: number;
}

interface Rename {
  /** Matched case-insensitively against the whole item name. */
  from: string;
  to: string;
  qty: number;
}

/**
 * Explicit, reviewed list rather than a clever regex.
 *
 * A generic "pull the number out of the parentheses" rule would happily turn
 * `Rope (50 feet)` into 50 ropes and `Water skins (filled)` into nothing
 * sensible -- the parenthetical is a DESCRIPTION in those, not a count. Only
 * entries where the number really is "how many of this thing do I have"
 * belong here. Add your own campaign's items to this list as needed.
 */
const RENAMES: Rename[] = [
  { from: "Aldric's Tinctures & Extracts (5 bottles)", to: "Aldric's tincture", qty: 5 },
  { from: 'Alchemical vials (2)', to: 'Alchemical vial', qty: 2 },
  { from: "Aldric's Healing Texts (3 volumes)", to: "Aldric's healing text", qty: 3 },
];

function parseArgs(argv: string[]) {
  const apply = argv.includes('--apply');
  const savesIdx = argv.indexOf('--saves-dir');
  const slugIdx = argv.indexOf('--slug');
  return {
    apply,
    savesDir: savesIdx !== -1 ? argv[savesIdx + 1] : path.join(process.cwd(), 'saves'),
    slug: slugIdx !== -1 ? argv[slugIdx + 1] : undefined,
  };
}

/** Applies RENAMES to one inventory array, returning the new array plus a human-readable changelog. Pure -- no I/O. */
export function repairInventory(inventory: Item[]): { inventory: Item[]; changes: string[] } {
  const changes: string[] = [];
  const out: Item[] = [];

  for (const item of inventory) {
    const rule = RENAMES.find((r) => r.from.toLowerCase() === item.name.toLowerCase());
    if (!rule) {
      out.push(item);
      continue;
    }
    // Preserve any multiplier the player somehow accumulated (2 stacks of 5 = 10).
    const newQty = rule.qty * Math.max(1, item.qty);
    changes.push(`  "${item.name}" x${item.qty}  ->  "${rule.to}" x${newQty}`);

    // If the target name already exists (partially-repaired save, or the DM
    // separately added a correctly-named one), merge instead of duplicating --
    // two entries with the same name would make removeItem's findIndex only
    // ever see the first.
    const existing = out.find((i) => i.name.toLowerCase() === rule.to.toLowerCase());
    if (existing) {
      existing.qty += newQty;
      changes.push(`  (merged into existing "${existing.name}", now x${existing.qty})`);
    } else {
      out.push({ name: rule.to, qty: newQty });
    }
  }

  return { inventory: out, changes };
}

function backup(file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.${stamp}.bak`;
  fs.copyFileSync(file, dest);
  return dest;
}

function main(): void {
  const { apply, savesDir, slug } = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(savesDir)) {
    console.error(`No saves directory at ${savesDir}. Pass --saves-dir <path>.`);
    process.exit(1);
  }

  const slugs = slug
    ? [slug]
    : fs.readdirSync(savesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

  console.log(`${apply ? 'APPLYING' : 'DRY RUN (nothing written -- pass --apply to write)'} in ${savesDir}\n`);

  let totalChanged = 0;

  for (const s of slugs) {
    const file = path.join(savesDir, s, 'character.json');
    if (!fs.existsSync(file)) continue;

    let raw: any;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.log(`${s}: SKIPPED — character.json is not valid JSON (${(err as Error).message})`);
      continue;
    }

    // Saves are versioned envelopes ({ schemaVersion, data }); tolerate a bare
    // object too so a hand-edited file still works.
    const character = raw?.data ?? raw;
    if (!Array.isArray(character?.inventory)) {
      console.log(`${s}: SKIPPED — no inventory array`);
      continue;
    }

    const { inventory, changes } = repairInventory(character.inventory);
    if (changes.length === 0) {
      console.log(`${s}: nothing to fix`);
      continue;
    }

    console.log(`${s}:`);
    changes.forEach((c) => console.log(c));

    if (apply) {
      const bak = backup(file);
      character.inventory = inventory;
      fs.writeFileSync(file, JSON.stringify(raw, null, 2));
      console.log(`  written (backup: ${path.basename(bak)})`);
    }
    console.log('');
    totalChanged++;
  }

  if (totalChanged === 0) {
    console.log('\nNo campaigns needed repair.');
  } else if (!apply) {
    console.log(`\n${totalChanged} campaign(s) would change. Re-run with --apply to write.`);
  } else {
    console.log(`\nRepaired ${totalChanged} campaign(s). Restart the server so it reloads the save.`);
  }
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]).endsWith('fix-item-names.ts');
if (isDirectRun) main();
