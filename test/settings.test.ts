import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadSettings, resolveModelOption } from '../src/game/settings';

describe('loadSettings', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-settings-'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const DEFAULT_OPENAI = { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1' };

  it('creates settings.json with haiku/haiku + claude/default-openai defaults when the file is missing, and returns no warning', () => {
    const { settings, warning } = loadSettings(baseDir);

    expect(settings).toEqual({
      dmModel: 'haiku',
      summarizerModel: 'haiku',
      dmBackend: 'claude',
      openai: DEFAULT_OPENAI,
    });
    expect(warning).toBeUndefined();

    const filePath = path.join(baseDir, 'settings.json');
    expect(fs.existsSync(filePath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(written).toEqual({
      dmModel: 'haiku',
      summarizerModel: 'haiku',
      dmBackend: 'claude',
      openai: DEFAULT_OPENAI,
    });
  });

  it('does not recreate the file, and returns no warning, on a second call once it exists', () => {
    loadSettings(baseDir);
    const firstWrite = fs.readFileSync(path.join(baseDir, 'settings.json'), 'utf8');
    const { settings, warning } = loadSettings(baseDir);
    expect(settings).toEqual({
      dmModel: 'haiku',
      summarizerModel: 'haiku',
      dmBackend: 'claude',
      openai: DEFAULT_OPENAI,
    });
    expect(warning).toBeUndefined();
    expect(fs.readFileSync(path.join(baseDir, 'settings.json'), 'utf8')).toBe(firstWrite);
  });

  it('respects a valid custom settings.json, silently defaulting dmBackend/openai when a pre-P1 file omits them', () => {
    fs.writeFileSync(
      path.join(baseDir, 'settings.json'),
      JSON.stringify({ dmModel: 'opus', summarizerModel: 'sonnet' }),
    );
    const { settings, warning } = loadSettings(baseDir);
    expect(settings).toEqual({
      dmModel: 'opus',
      summarizerModel: 'sonnet',
      dmBackend: 'claude',
      openai: DEFAULT_OPENAI,
    });
    expect(warning).toBeUndefined();
  });

  it('accepts "default" as a valid model value', () => {
    fs.writeFileSync(
      path.join(baseDir, 'settings.json'),
      JSON.stringify({ dmModel: 'default', summarizerModel: 'default' }),
    );
    const { settings } = loadSettings(baseDir);
    expect(settings.dmModel).toBe('default');
    expect(settings.summarizerModel).toBe('default');
  });

  it('falls back to defaults with a warning when the file is not valid JSON, and never throws', () => {
    fs.writeFileSync(path.join(baseDir, 'settings.json'), '{ this is not json');
    let result: ReturnType<typeof loadSettings> | undefined;
    expect(() => {
      result = loadSettings(baseDir);
    }).not.toThrow();
    expect(result?.settings).toEqual({
      dmModel: 'haiku',
      summarizerModel: 'haiku',
      dmBackend: 'claude',
      openai: DEFAULT_OPENAI,
    });
    expect(result?.warning).toBeDefined();
  });

  it('respects a valid custom dmBackend + openai config, with no warning', () => {
    fs.writeFileSync(
      path.join(baseDir, 'settings.json'),
      JSON.stringify({
        dmModel: 'haiku',
        summarizerModel: 'haiku',
        dmBackend: 'openai',
        openai: { baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.1-70b-instruct', apiKeyEnv: 'OPENROUTER_API_KEY' },
      }),
    );
    const { settings, warning } = loadSettings(baseDir);
    expect(settings.dmBackend).toBe('openai');
    expect(settings.openai).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'meta-llama/llama-3.1-70b-instruct',
      apiKeyEnv: 'OPENROUTER_API_KEY',
    });
    expect(warning).toBeUndefined();
  });

  it('respects "dual" as a valid dmBackend, and a valid narratorModel alongside model/apiKeyEnv, with no warning', () => {
    fs.writeFileSync(
      path.join(baseDir, 'settings.json'),
      JSON.stringify({
        dmModel: 'haiku',
        summarizerModel: 'haiku',
        dmBackend: 'dual',
        openai: {
          baseUrl: 'https://openrouter.ai/api/v1',
          model: 'meta-llama/llama-3.3-70b-instruct',
          apiKeyEnv: 'OPENROUTER_API_KEY',
          narratorModel: 'nousresearch/hermes-3-llama-3.1-70b',
        },
      }),
    );
    const { settings, warning } = loadSettings(baseDir);
    expect(settings.dmBackend).toBe('dual');
    expect(settings.openai).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'meta-llama/llama-3.3-70b-instruct',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      narratorModel: 'nousresearch/hermes-3-llama-3.1-70b',
    });
    expect(warning).toBeUndefined();
  });

  it('falls back to the default openai config with a warning when narratorModel is present but not a string', () => {
    fs.writeFileSync(
      path.join(baseDir, 'settings.json'),
      JSON.stringify({
        dmModel: 'haiku',
        summarizerModel: 'haiku',
        dmBackend: 'dual',
        openai: { baseUrl: 'http://localhost:1234/v1', model: 'llama3.1', narratorModel: 123 },
      }),
    );
    const { settings, warning } = loadSettings(baseDir);
    expect(settings.openai).toEqual(DEFAULT_OPENAI);
    expect(warning).toBeDefined();
    expect(settings.dmBackend).toBe('dual');
  });

  it('falls back to dmBackend "claude" with a warning when dmBackend is present but invalid', () => {
    fs.writeFileSync(
      path.join(baseDir, 'settings.json'),
      JSON.stringify({ dmModel: 'haiku', summarizerModel: 'haiku', dmBackend: 'gpt5' }),
    );
    const { settings, warning } = loadSettings(baseDir);
    expect(settings.dmBackend).toBe('claude');
    expect(warning).toBeDefined();
  });

  it('falls back to the default openai config with a warning when openai is present but malformed (missing model)', () => {
    fs.writeFileSync(
      path.join(baseDir, 'settings.json'),
      JSON.stringify({ dmModel: 'haiku', summarizerModel: 'haiku', dmBackend: 'openai', openai: { baseUrl: 'http://localhost:1234/v1' } }),
    );
    const { settings, warning } = loadSettings(baseDir);
    expect(settings.openai).toEqual(DEFAULT_OPENAI);
    expect(warning).toBeDefined();
    // dmBackend itself was valid -- only openai was wrong -- so it's still honored.
    expect(settings.dmBackend).toBe('openai');
  });

  it('falls back to defaults with a warning when a model field has an invalid value', () => {
    fs.writeFileSync(
      path.join(baseDir, 'settings.json'),
      JSON.stringify({ dmModel: 'gpt-5', summarizerModel: 'haiku' }),
    );
    const { settings, warning } = loadSettings(baseDir);
    expect(settings.dmModel).toBe('haiku'); // invalid field replaced with the default
    expect(settings.summarizerModel).toBe('haiku'); // valid field still honored
    expect(warning).toBeDefined();
  });

  it('falls back to defaults with a warning when a model field is missing entirely', () => {
    fs.writeFileSync(path.join(baseDir, 'settings.json'), JSON.stringify({ dmModel: 'sonnet' }));
    const { settings, warning } = loadSettings(baseDir);
    expect(settings.dmModel).toBe('sonnet');
    expect(settings.summarizerModel).toBe('haiku');
    expect(warning).toBeDefined();
  });

  it('does not overwrite a malformed file on disk (never destroys a player mid-edit)', () => {
    fs.writeFileSync(path.join(baseDir, 'settings.json'), '{ broken');
    loadSettings(baseDir);
    expect(fs.readFileSync(path.join(baseDir, 'settings.json'), 'utf8')).toBe('{ broken');
  });

  describe('P2 env overrides (DND_DM_BACKEND / DND_OPENAI_*)', () => {
    it('is a no-op with none of the four env vars set -- identical to the file/default result', () => {
      const withoutEnv = loadSettings(baseDir, {});
      expect(withoutEnv.settings).toEqual({
        dmModel: 'haiku',
        summarizerModel: 'haiku',
        dmBackend: 'claude',
        openai: DEFAULT_OPENAI,
      });
      expect(withoutEnv.warning).toBeUndefined();
    });

    it('DND_DM_BACKEND overrides a missing/absent settings.json to "openai"', () => {
      const { settings, warning } = loadSettings(baseDir, { DND_DM_BACKEND: 'openai' });
      expect(settings.dmBackend).toBe('openai');
      expect(warning).toBeUndefined();
      // Sensible default apiKeyEnv kicks in once env drives the backend to
      // "openai" and nothing (env or file) named an apiKeyEnv.
      expect(settings.openai.apiKeyEnv).toBe('OPENROUTER_API_KEY');
    });

    it('DND_OPENAI_BASE_URL / DND_OPENAI_MODEL / DND_OPENAI_API_KEY_ENV each override independently, leaving dmBackend from the file alone', () => {
      const { settings } = loadSettings(baseDir, {
        DND_OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
        DND_OPENAI_MODEL: 'meta-llama/llama-3.1-70b-instruct',
        DND_OPENAI_API_KEY_ENV: 'OPENROUTER_API_KEY',
      });
      // No DND_DM_BACKEND given, and the file has none either -> stays 'claude'.
      expect(settings.dmBackend).toBe('claude');
      expect(settings.openai).toEqual({
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'meta-llama/llama-3.1-70b-instruct',
        apiKeyEnv: 'OPENROUTER_API_KEY',
      });
    });

    it('env overrides win over an explicit file value (env > file > built-in default)', () => {
      fs.writeFileSync(
        path.join(baseDir, 'settings.json'),
        JSON.stringify({
          dmModel: 'haiku',
          summarizerModel: 'haiku',
          dmBackend: 'openai',
          openai: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1', apiKeyEnv: 'SOME_OTHER_KEY' },
        }),
      );
      const { settings, warning } = loadSettings(baseDir, { DND_OPENAI_MODEL: 'llama3.1:70b' });
      expect(warning).toBeUndefined();
      expect(settings.dmBackend).toBe('openai'); // untouched -- no DND_DM_BACKEND given
      expect(settings.openai).toEqual({
        baseUrl: 'http://127.0.0.1:11434/v1', // from file, no env override given
        model: 'llama3.1:70b', // env override wins over the file's 'llama3.1'
        apiKeyEnv: 'SOME_OTHER_KEY', // from file, no env override given
      });
    });

    it('an invalid DND_DM_BACKEND value is ignored (never throws), falling back to the file/default value', () => {
      let result: ReturnType<typeof loadSettings> | undefined;
      expect(() => {
        result = loadSettings(baseDir, { DND_DM_BACKEND: 'gpt5-turbo' });
      }).not.toThrow();
      expect(result?.settings.dmBackend).toBe('claude');
    });

    it('does not clobber a real file-configured apiKeyEnv with the OPENROUTER_API_KEY sensible default', () => {
      fs.writeFileSync(
        path.join(baseDir, 'settings.json'),
        JSON.stringify({
          dmModel: 'haiku',
          summarizerModel: 'haiku',
          dmBackend: 'openai',
          openai: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1', apiKeyEnv: 'MY_CUSTOM_KEY_ENV' },
        }),
      );
      const { settings } = loadSettings(baseDir, { DND_OPENAI_MODEL: 'llama3.1:70b' });
      expect(settings.openai.apiKeyEnv).toBe('MY_CUSTOM_KEY_ENV');
    });

    it('a blank/whitespace-only env var is treated as unset, not as an override to ""', () => {
      const { settings } = loadSettings(baseDir, { DND_OPENAI_MODEL: '   ' });
      expect(settings.openai).toEqual(DEFAULT_OPENAI);
    });

    it('DND_DM_BACKEND accepts "dual"', () => {
      const { settings, warning } = loadSettings(baseDir, { DND_DM_BACKEND: 'dual' });
      expect(settings.dmBackend).toBe('dual');
      expect(warning).toBeUndefined();
      // Same sensible apiKeyEnv fallback as "openai" once env drives the backend.
      expect(settings.openai.apiKeyEnv).toBe('OPENROUTER_API_KEY');
    });

    it('DND_OPENAI_NARRATOR_MODEL overrides narratorModel independently, leaving model/baseUrl/apiKeyEnv alone', () => {
      const { settings } = loadSettings(baseDir, { DND_OPENAI_NARRATOR_MODEL: 'nousresearch/hermes-3-llama-3.1-70b' });
      expect(settings.openai).toEqual({
        ...DEFAULT_OPENAI,
        narratorModel: 'nousresearch/hermes-3-llama-3.1-70b',
      });
    });

    it('env DND_OPENAI_NARRATOR_MODEL wins over a file-configured narratorModel', () => {
      fs.writeFileSync(
        path.join(baseDir, 'settings.json'),
        JSON.stringify({
          dmModel: 'haiku',
          summarizerModel: 'haiku',
          dmBackend: 'dual',
          openai: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1', narratorModel: 'file-narrator' },
        }),
      );
      const { settings } = loadSettings(baseDir, { DND_OPENAI_NARRATOR_MODEL: 'env-narrator' });
      expect(settings.openai.narratorModel).toBe('env-narrator');
    });

    it('a blank/whitespace-only DND_OPENAI_NARRATOR_MODEL is treated as unset', () => {
      const { settings } = loadSettings(baseDir, { DND_OPENAI_NARRATOR_MODEL: '   ' });
      expect(settings.openai).toEqual(DEFAULT_OPENAI);
    });
  });
});

describe('resolveModelOption', () => {
  it("maps 'default' to undefined (omit the SDK option)", () => {
    expect(resolveModelOption('default')).toBeUndefined();
  });

  it('passes haiku/sonnet/opus through unchanged', () => {
    expect(resolveModelOption('haiku')).toBe('haiku');
    expect(resolveModelOption('sonnet')).toBe('sonnet');
    expect(resolveModelOption('opus')).toBe('opus');
  });
});
