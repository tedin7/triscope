import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultChromeBinary, inferGraphicalEnv, parseExtraChromeArgs, tailLines } from '../src/browser.js';

/**
 * Only the pure helpers are unit-tested here. The full `createBrowserPool`
 * flow needs a real Chromium child + a CDP websocket and is best exercised
 * by `triscope smoke` end-to-end (out of phase-1 scope).
 */

describe('parseExtraChromeArgs', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.TRISCOPE_CHROME_ARGS; });
  afterEach(() => {
    if (saved === undefined) delete process.env.TRISCOPE_CHROME_ARGS;
    else process.env.TRISCOPE_CHROME_ARGS = saved;
  });

  it('returns [] when env is unset', () => {
    delete process.env.TRISCOPE_CHROME_ARGS;
    expect(parseExtraChromeArgs()).toEqual([]);
  });

  it('returns [] when env is blank', () => {
    process.env.TRISCOPE_CHROME_ARGS = '   ';
    expect(parseExtraChromeArgs()).toEqual([]);
  });

  it('whitespace-splits the env value', () => {
    process.env.TRISCOPE_CHROME_ARGS = '--headless=new --disable-dev-shm-usage';
    expect(parseExtraChromeArgs()).toEqual(['--headless=new', '--disable-dev-shm-usage']);
  });

  it('collapses runs of whitespace', () => {
    process.env.TRISCOPE_CHROME_ARGS = '  --a   --b\t--c\n--d  ';
    expect(parseExtraChromeArgs()).toEqual(['--a', '--b', '--c', '--d']);
  });
});

describe('tailLines', () => {
  it('returns "" when input is empty/whitespace', () => {
    expect(tailLines('')).toBe('');
    expect(tailLines('   \n\n')).toBe('');
  });

  it('strips blank lines', () => {
    expect(tailLines('a\n\nb\n\n')).toBe('a\nb');
  });

  it('caps the output to the last `max` lines', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
    const out = tailLines(text, 5);
    expect(out.split('\n')).toEqual(['line45', 'line46', 'line47', 'line48', 'line49']);
  });

  it('handles \\r\\n line endings', () => {
    expect(tailLines('a\r\nb\r\nc', 2)).toBe('b\nc');
  });
});

describe('defaultChromeBinary', () => {
  it('returns a platform-appropriate string', () => {
    const out = defaultChromeBinary();
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    if (process.platform === 'win32') expect(out).toMatch(/chrome\.exe$/i);
    else if (process.platform === 'darwin') expect(out).toMatch(/Google Chrome$/);
    else expect(out).toBe('chromium');
  });
});

describe('inferGraphicalEnv', () => {
  it('returns process.env unchanged on non-linux', () => {
    if (process.platform === 'linux') {
      // Skip on linux — we can't easily simulate another platform without a stub.
      return;
    }
    expect(inferGraphicalEnv()).toBe(process.env);
  });

  it('on linux: returns a copy (not the same object reference)', () => {
    if (process.platform !== 'linux') return;
    const env = inferGraphicalEnv();
    expect(env).not.toBe(process.env);
    // Should be a superset of the current env (it never deletes keys).
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('on linux: preserves explicit WAYLAND_DISPLAY when already set', () => {
    if (process.platform !== 'linux') return;
    const saved = process.env.WAYLAND_DISPLAY;
    process.env.WAYLAND_DISPLAY = 'wayland-9';
    try {
      const env = inferGraphicalEnv();
      expect(env.WAYLAND_DISPLAY).toBe('wayland-9');
    } finally {
      if (saved === undefined) delete process.env.WAYLAND_DISPLAY;
      else process.env.WAYLAND_DISPLAY = saved;
    }
  });
});
