// Player-level model settings: which Claude model narrates (the DM) and
// which one runs the cheap chronicle summarizer. Lives in `settings.json` at
// the repo root (NOT saves/, and NOT per-campaign) -- gitignored, so it's a
// local machine preference, not something that ships in the repo or a save.
//
// loadSettings() never throws: a missing file is created with the defaults
// on first read; a malformed one falls back to the defaults and reports a
// `warning` string for the caller to surface however it can (dm.ts routes it
// through its onSystemNote callback; summarizer.ts has no such channel and
// just falls back silently to avoid double-reporting the same warning).

import * as fs from 'node:fs';
import * as path from 'node:path';

export type ModelSetting = 'default' | 'haiku' | 'sonnet' | 'opus';

export interface Settings {
  dmModel: ModelSetting;
  summarizerModel: ModelSetting;
}

export interface LoadedSettings {
  settings: Settings;
  /** Set only when settings.json existed but was missing/invalid fields, or wasn't valid JSON. */
  warning?: string;
}

const VALID_MODELS: readonly ModelSetting[] = ['default', 'haiku', 'sonnet', 'opus'];
const DEFAULT_SETTINGS: Settings = { dmModel: 'haiku', summarizerModel: 'haiku' };

function isModelSetting(value: unknown): value is ModelSetting {
  return typeof value === 'string' && (VALID_MODELS as readonly string[]).includes(value);
}

function settingsPath(baseDir: string): string {
  return path.join(baseDir, 'settings.json');
}

/**
 * Loads settings.json from `baseDir` (repo root in production). Missing file
 * -> written with defaults, no warning (that's expected on first boot).
 * Present but malformed/invalid -> defaults used in memory, `warning` set;
 * the file on disk is left untouched (never overwrite a player's file just
 * because we couldn't parse part of it -- they may be mid-edit).
 */
export function loadSettings(baseDir: string = process.cwd()): LoadedSettings {
  const filePath = settingsPath(baseDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    try {
      fs.mkdirSync(baseDir, { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`, 'utf8');
    } catch {
      // Best-effort only -- an unwritable directory shouldn't crash the game.
    }
    return { settings: { ...DEFAULT_SETTINGS } };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('settings.json must contain a JSON object');
    }
    const obj = parsed as Record<string, unknown>;
    const dmModel = isModelSetting(obj.dmModel) ? obj.dmModel : undefined;
    const summarizerModel = isModelSetting(obj.summarizerModel) ? obj.summarizerModel : undefined;
    if (dmModel === undefined || summarizerModel === undefined) {
      return {
        settings: {
          dmModel: dmModel ?? DEFAULT_SETTINGS.dmModel,
          summarizerModel: summarizerModel ?? DEFAULT_SETTINGS.summarizerModel,
        },
        warning: `settings.json has a missing/invalid model field — using defaults (dmModel/summarizerModel: haiku) for what's missing. Valid values: ${VALID_MODELS.join(', ')}.`,
      };
    }
    return { settings: { dmModel, summarizerModel } };
  } catch {
    return {
      settings: { ...DEFAULT_SETTINGS },
      warning: 'settings.json is not valid JSON — using defaults (dmModel/summarizerModel: haiku) until it is fixed.',
    };
  }
}

/** 'default' means "omit the SDK model option" (falls through to the player's Claude Code default); everything else passes through as-is. */
export function resolveModelOption(setting: ModelSetting): string | undefined {
  return setting === 'default' ? undefined : setting;
}
