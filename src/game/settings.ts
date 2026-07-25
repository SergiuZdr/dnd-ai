// Player-level model settings: which Claude model narrates (the DM) and
// which one runs the cheap chronicle summarizer. Lives in `settings.json` at
// the repo root (NOT saves/, and NOT per-campaign) -- gitignored, so it's a
// local machine preference, not something that ships in the repo or a save.
//
// Also carries the P1 pluggable-backend config: dmBackend picks which
// DmSession implementation the controller's default sessionFactory
// constructs (see game/controller.ts), and openai holds the OpenAI-compatible
// endpoint config (base URL, model, and the NAME of an env var to read the
// API key from -- never the key value itself, which is never read from or
// written to this file). dmBackend defaults to 'claude' so an existing
// settings.json (or a missing one) behaves exactly as before P1 shipped.
//
// P1.5 (dual referee+narrator backend, additive on top of P1): dmBackend
// also accepts 'dual', which routes the DM through DualModelDmSession
// (src/ai/dualDm.ts) -- a RELIABLE tool-calling model resolves mechanics
// (the "referee"), and a separate, more permissive model writes the prose
// the player reads (the "narrator"), both via the SAME openai.baseUrl/
// apiKeyEnv (one endpoint, two model ids). openai.narratorModel names the
// narrator's model; when 'dual' is active but narratorModel is unset,
// DualModelDmSession falls back to reusing openai.model for the narrator
// too (with a friendly onSystemNote so the owner notices and can configure a
// dedicated narrator model). Recommended split: a reliable tool-caller for
// the referee (e.g. "meta-llama/llama-3.3-70b-instruct") and an
// uncensored-leaning model for the narrator (e.g.
// "nousresearch/hermes-3-llama-3.1-70b") -- see docs/DEPLOY.md.
//
// loadSettings() never throws: a missing file is created with the defaults
// on first read; a malformed one falls back to the defaults and reports a
// `warning` string for the caller to surface however it can (dm.ts routes it
// through its onSystemNote callback; summarizer.ts has no such channel and
// just falls back silently to avoid double-reporting the same warning).
//
// P2 (cloud deploy) env overrides: a container/VM should be configurable
// entirely via env vars/secrets, with NO settings.json committed or even
// present on the server. DND_DM_BACKEND / DND_OPENAI_BASE_URL /
// DND_OPENAI_MODEL / DND_OPENAI_API_KEY_ENV / DND_OPENAI_NARRATOR_MODEL, when
// set, override whatever the file (or built-in default) says -- precedence
// is env > file > built-in default. With none of those five vars set,
// applyEnvOverrides() is a byte-for-byte no-op, so local dev with no env
// vars behaves exactly as before P2 (see the test suite's "no env set"
// cases).

import * as fs from 'node:fs';
import * as path from 'node:path';

export type ModelSetting = 'default' | 'haiku' | 'sonnet' | 'opus';

export type DmBackend = 'claude' | 'openai' | 'dual';

export interface OpenAiSettings {
  /** e.g. "http://127.0.0.1:11434/v1" (local Ollama) or an OpenRouter/self-host base URL. No trailing slash required. */
  baseUrl: string;
  /** Model tag as the endpoint expects it, e.g. "llama3.1" or "meta-llama/llama-3.1-70b-instruct". */
  model: string;
  /** Name of an environment variable to read the API key from at session start -- e.g. "OPENROUTER_API_KEY". The key itself is never stored here. Omit for endpoints that need no key (e.g. local Ollama). */
  apiKeyEnv?: string;
  /**
   * Only consulted when dmBackend is 'dual' (src/ai/dualDm.ts): the model
   * that writes player-facing narration (the "narrator"), while `model`
   * above becomes the mechanics-resolving "referee". Same endpoint
   * (baseUrl/apiKeyEnv) as the referee -- just a second model id, so an
   * uncensored-leaning model can narrate while a reliable tool-caller keeps
   * the dice/ledger honest. When unset, DualModelDmSession falls back to
   * reusing `model` for the narrator too (with a friendly onSystemNote).
   */
  narratorModel?: string;
}

export interface Settings {
  dmModel: ModelSetting;
  summarizerModel: ModelSetting;
  /** Which DmSession implementation the controller's default sessionFactory builds. Default 'claude' -- nothing changes until the owner opts in. */
  dmBackend: DmBackend;
  /** Only consulted when dmBackend is 'openai'. Defaults to a zero-config local Ollama endpoint. */
  openai: OpenAiSettings;
}

export interface LoadedSettings {
  settings: Settings;
  /** Set only when settings.json existed but was missing/invalid fields, or wasn't valid JSON. */
  warning?: string;
}

const VALID_MODELS: readonly ModelSetting[] = ['default', 'haiku', 'sonnet', 'opus'];
const VALID_DM_BACKENDS: readonly DmBackend[] = ['claude', 'openai', 'dual'];

/** Zero-config dev default: a local Ollama server, no key required. Model is a placeholder -- the PRD's own spike found small (3B) local models too weak for reliable tool-calling, so a real setup should point this at a capable model (a bigger local pull, or a capable free-tier cloud model via baseUrl/apiKeyEnv). */
const DEFAULT_OPENAI_SETTINGS: OpenAiSettings = {
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'llama3.1',
};

const DEFAULT_SETTINGS: Settings = {
  dmModel: 'haiku',
  summarizerModel: 'haiku',
  dmBackend: 'claude',
  openai: { ...DEFAULT_OPENAI_SETTINGS },
};

function isModelSetting(value: unknown): value is ModelSetting {
  return typeof value === 'string' && (VALID_MODELS as readonly string[]).includes(value);
}

function isDmBackend(value: unknown): value is DmBackend {
  return typeof value === 'string' && (VALID_DM_BACKENDS as readonly string[]).includes(value);
}

function isOpenAiSettings(value: unknown): value is OpenAiSettings {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.baseUrl !== 'string' || obj.baseUrl.length === 0) return false;
  if (typeof obj.model !== 'string' || obj.model.length === 0) return false;
  if (obj.apiKeyEnv !== undefined && typeof obj.apiKeyEnv !== 'string') return false;
  if (obj.narratorModel !== undefined && typeof obj.narratorModel !== 'string') return false;
  return true;
}

function settingsPath(baseDir: string): string {
  return path.join(baseDir, 'settings.json');
}

/** undefined/empty/whitespace-only -> undefined, so an env var that's set-but-blank behaves like it's unset rather than overriding with "". */
function nonEmptyEnv(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * P2: env-var overrides for the AI backend, applied on top of whatever
 * loadSettings() already resolved from the file (or built-in defaults). This
 * is what lets a cloud deploy configure the DM entirely via env/secrets with
 * no settings.json needed on the server at all.
 *
 * With none of the four vars set, this returns `loaded` completely
 * unchanged -- local dev (`npm run serve` with no env vars) is byte-for-byte
 * unaffected. `warning` (about the FILE) is passed through untouched; an
 * invalid DND_DM_BACKEND value is simply ignored (falls back to whatever the
 * file/default already resolved), never thrown -- same never-crash spirit as
 * the rest of this module.
 */
function applyEnvOverrides(loaded: LoadedSettings, env: NodeJS.ProcessEnv): LoadedSettings {
  const rawBackend = env.DND_DM_BACKEND;
  const rawBaseUrl = nonEmptyEnv(env.DND_OPENAI_BASE_URL);
  const rawModel = nonEmptyEnv(env.DND_OPENAI_MODEL);
  const rawApiKeyEnv = nonEmptyEnv(env.DND_OPENAI_API_KEY_ENV);
  const rawNarratorModel = nonEmptyEnv(env.DND_OPENAI_NARRATOR_MODEL);

  const anyEnvSet =
    rawBackend !== undefined ||
    rawBaseUrl !== undefined ||
    rawModel !== undefined ||
    rawApiKeyEnv !== undefined ||
    rawNarratorModel !== undefined;
  if (!anyEnvSet) return loaded;

  const dmBackend = isDmBackend(rawBackend) ? rawBackend : loaded.settings.dmBackend;
  const baseUrl = rawBaseUrl ?? loaded.settings.openai.baseUrl;
  const model = rawModel ?? loaded.settings.openai.model;
  const narratorModel = rawNarratorModel ?? loaded.settings.openai.narratorModel;
  // Sensible default (per the PRD/deploy docs): a cloud deploy sets
  // DND_DM_BACKEND=openai + DND_OPENAI_BASE_URL/MODEL but may not bother
  // setting DND_OPENAI_API_KEY_ENV too -- OPENROUTER_API_KEY is this
  // project's one documented free/uncensored endpoint, so it's the sensible
  // fallback *name* (not the key value -- see OpenAiSettings.apiKeyEnv) once
  // env is actively driving the backend to "openai"/"dual" and no apiKeyEnv
  // is known from anywhere (env or file).
  const apiKeyEnv =
    rawApiKeyEnv ??
    loaded.settings.openai.apiKeyEnv ??
    (dmBackend === 'openai' || dmBackend === 'dual' ? 'OPENROUTER_API_KEY' : undefined);

  return {
    settings: {
      ...loaded.settings,
      dmBackend,
      openai: { baseUrl, model, apiKeyEnv, ...(narratorModel !== undefined ? { narratorModel } : {}) },
    },
    warning: loaded.warning,
  };
}

/**
 * Loads settings.json from `baseDir` (repo root in production), then applies
 * any DND_DM_BACKEND/DND_OPENAI_* env overrides (see applyEnvOverrides()
 * above) -- `env` defaults to `process.env` and is a test seam, not
 * something production callers need to pass. Missing file -> written with
 * defaults, no warning (that's expected on first boot). Present but
 * malformed/invalid -> defaults used in memory, `warning` set; the file on
 * disk is left untouched (never overwrite a player's file just because we
 * couldn't parse part of it -- they may be mid-edit).
 */
export function loadSettings(baseDir: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): LoadedSettings {
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
    return applyEnvOverrides({ settings: { ...DEFAULT_SETTINGS } }, env);
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('settings.json must contain a JSON object');
    }
    const obj = parsed as Record<string, unknown>;
    const dmModel = isModelSetting(obj.dmModel) ? obj.dmModel : undefined;
    const summarizerModel = isModelSetting(obj.summarizerModel) ? obj.summarizerModel : undefined;
    const modelFieldsMissing = dmModel === undefined || summarizerModel === undefined;

    // dmBackend/openai are newer, additive, opt-in fields (P1): a
    // settings.json that predates them, or simply never mentions them,
    // silently defaults to dmBackend:'claude' with NO warning -- that's the
    // whole point of "additive + config-flagged". Only a PRESENT-but-invalid
    // value warns, same spirit as dmModel/summarizerModel above but without
    // penalizing files that never knew about this feature.
    const dmBackendInvalid = obj.dmBackend !== undefined && !isDmBackend(obj.dmBackend);
    const dmBackend = isDmBackend(obj.dmBackend) ? obj.dmBackend : DEFAULT_SETTINGS.dmBackend;

    const openaiInvalid = obj.openai !== undefined && !isOpenAiSettings(obj.openai);
    const openai = isOpenAiSettings(obj.openai) ? obj.openai : { ...DEFAULT_OPENAI_SETTINGS };

    if (modelFieldsMissing || dmBackendInvalid || openaiInvalid) {
      const problems: string[] = [];
      if (modelFieldsMissing) {
        problems.push(
          `missing/invalid model field(s) — using defaults (dmModel/summarizerModel: haiku) for what's missing. Valid values: ${VALID_MODELS.join(', ')}`,
        );
      }
      if (dmBackendInvalid) {
        problems.push(`invalid dmBackend value — using "claude". Valid values: ${VALID_DM_BACKENDS.join(', ')}`);
      }
      if (openaiInvalid) {
        problems.push(
          'invalid openai config — using defaults (expects { baseUrl: string, model: string, apiKeyEnv?: string })',
        );
      }
      return applyEnvOverrides(
        {
          settings: {
            dmModel: dmModel ?? DEFAULT_SETTINGS.dmModel,
            summarizerModel: summarizerModel ?? DEFAULT_SETTINGS.summarizerModel,
            dmBackend,
            openai,
          },
          warning: `settings.json: ${problems.join('; ')}.`,
        },
        env,
      );
    }
    return applyEnvOverrides({ settings: { dmModel, summarizerModel, dmBackend, openai } }, env);
  } catch {
    return applyEnvOverrides(
      {
        settings: { dmModel: DEFAULT_SETTINGS.dmModel, summarizerModel: DEFAULT_SETTINGS.summarizerModel, dmBackend: DEFAULT_SETTINGS.dmBackend, openai: { ...DEFAULT_OPENAI_SETTINGS } },
        warning: 'settings.json is not valid JSON — using defaults (dmModel/summarizerModel: haiku) until it is fixed.',
      },
      env,
    );
  }
}

/** 'default' means "omit the SDK model option" (falls through to the player's Claude Code default); everything else passes through as-is. */
export function resolveModelOption(setting: ModelSetting): string | undefined {
  return setting === 'default' ? undefined : setting;
}
