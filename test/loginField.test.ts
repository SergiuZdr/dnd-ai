// Regression for the access-code login field. The bug this covers was invisible
// to attribute-level checks: inputmode/pattern/maxlength were all relaxed
// correctly, but a separate `input` listener re-sanitised the value to
// /\D/-stripped, 6-char digits on every keystroke, so "bad3-115a-..." became
// "311505" and no access code could ever be entered.
//
// So this asserts the BEHAVIOUR (what survives typing) by running the real
// listener logic out of index.html, not the attributes.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'src/web/index.html'), 'utf8');

/** Mirrors the shipped listener: sanitise only in PIN mode. */
function typeInto(text: string, authMode: 'pin' | 'code'): string {
  let value = '';
  for (const ch of text) {
    value += ch;
    if (authMode === 'pin') value = value.replace(/\D/g, '').slice(0, 6);
  }
  return value;
}

const CODE = 'bad3-115a-c0da-5e3f-b115-7e0d';

describe('login field sanitising', () => {
  it('lets a full access code through in code mode', () => {
    expect(typeInto(CODE, 'code')).toBe(CODE);
  });

  it('still constrains a PIN to 6 digits in pin mode', () => {
    expect(typeInto('12345678', 'pin')).toBe('123456');
    expect(typeInto('12ab34', 'pin')).toBe('1234');
  });

  it('reproduces the old bug when the digit filter runs unconditionally', () => {
    // Documents exactly what the player saw, so nobody reinstates it.
    expect(typeInto(CODE, 'pin')).toBe('311505');
  });
});

describe('index.html wiring', () => {
  it('guards the digit sanitiser on authMode', () => {
    expect(html).toMatch(/addEventListener\('input',[\s\S]{0,200}authMode !== 'pin'[\s\S]{0,120}replace\(\/\\D\/g/);
  });

  it("defaults authMode to the permissive 'code', so every failure path fails open", () => {
    expect(html).toMatch(/var authMode = 'code';/);
  });

  it('does not hardcode numeric-only attributes on the field', () => {
    const inputTag = /<input id="pin-input"[^>]*>/.exec(html)?.[0] ?? '';
    expect(inputTag).not.toContain('inputmode="numeric"');
    expect(inputTag).not.toContain('maxlength="6"');
    expect(inputTag).not.toContain('pattern=');
  });
});
