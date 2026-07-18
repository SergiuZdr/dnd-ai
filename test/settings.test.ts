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

  it('creates settings.json with haiku/haiku defaults when the file is missing, and returns no warning', () => {
    const { settings, warning } = loadSettings(baseDir);

    expect(settings).toEqual({ dmModel: 'haiku', summarizerModel: 'haiku' });
    expect(warning).toBeUndefined();

    const filePath = path.join(baseDir, 'settings.json');
    expect(fs.existsSync(filePath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(written).toEqual({ dmModel: 'haiku', summarizerModel: 'haiku' });
  });

  it('does not recreate the file, and returns no warning, on a second call once it exists', () => {
    loadSettings(baseDir);
    const firstWrite = fs.readFileSync(path.join(baseDir, 'settings.json'), 'utf8');
    const { settings, warning } = loadSettings(baseDir);
    expect(settings).toEqual({ dmModel: 'haiku', summarizerModel: 'haiku' });
    expect(warning).toBeUndefined();
    expect(fs.readFileSync(path.join(baseDir, 'settings.json'), 'utf8')).toBe(firstWrite);
  });

  it('respects a valid custom settings.json', () => {
    fs.writeFileSync(
      path.join(baseDir, 'settings.json'),
      JSON.stringify({ dmModel: 'opus', summarizerModel: 'sonnet' }),
    );
    const { settings, warning } = loadSettings(baseDir);
    expect(settings).toEqual({ dmModel: 'opus', summarizerModel: 'sonnet' });
    expect(warning).toBeUndefined();
  });

  it('accepts "default" as a valid model value', () => {
    fs.writeFileSync(
      path.join(baseDir, 'settings.json'),
      JSON.stringify({ dmModel: 'default', summarizerModel: 'default' }),
    );
    const { settings } = loadSettings(baseDir);
    expect(settings).toEqual({ dmModel: 'default', summarizerModel: 'default' });
  });

  it('falls back to defaults with a warning when the file is not valid JSON, and never throws', () => {
    fs.writeFileSync(path.join(baseDir, 'settings.json'), '{ this is not json');
    let result: ReturnType<typeof loadSettings> | undefined;
    expect(() => {
      result = loadSettings(baseDir);
    }).not.toThrow();
    expect(result?.settings).toEqual({ dmModel: 'haiku', summarizerModel: 'haiku' });
    expect(result?.warning).toBeDefined();
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
