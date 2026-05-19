import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultChromeBinary, inferGraphicalEnv, parseExtraChromeArgs, tailLines } from '../src/browser.js';

const IS_LINUX = process.platform === 'linux';

/**
 * Helper to temporarily override the (read-only) process.platform string so
 * we can exercise every branch of the platform-aware helpers regardless of
 * the host the tests run on. Restored in `afterEach` of each describe that
 * uses it.
 */
function withPlatform(value: NodeJS.Platform, fn: () => void) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...desc, value });
  try { fn(); } finally { Object.defineProperty(process, 'platform', desc); }
}

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

  it('collapses runs of mixed whitespace (spaces / tabs / newlines)', () => {
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

  it('keeps all lines when count <= max', () => {
    expect(tailLines('a\nb\nc', 24)).toBe('a\nb\nc');
  });
});

describe('defaultChromeBinary', () => {
  it('returns the macOS Chrome path on darwin', () => {
    withPlatform('darwin', () => {
      expect(defaultChromeBinary()).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    });
  });

  it('returns the typical 64-bit Windows install path on win32', () => {
    withPlatform('win32', () => {
      expect(defaultChromeBinary()).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    });
  });

  it('returns "chromium" on linux (PATH-relative)', () => {
    withPlatform('linux', () => {
      expect(defaultChromeBinary()).toBe('chromium');
    });
  });

  it('returns "chromium" on other unix-like platforms (e.g. freebsd)', () => {
    withPlatform('freebsd' as NodeJS.Platform, () => {
      expect(defaultChromeBinary()).toBe('chromium');
    });
  });
});

describe('inferGraphicalEnv — non-linux paths (stubbed)', () => {
  it('returns process.env unchanged on darwin', () => {
    withPlatform('darwin', () => {
      expect(inferGraphicalEnv()).toBe(process.env);
    });
  });
  it('returns process.env unchanged on win32', () => {
    withPlatform('win32', () => {
      expect(inferGraphicalEnv()).toBe(process.env);
    });
  });
});

describe('inferGraphicalEnv — linux (stubbed platform + tmp XDG_RUNTIME_DIR)', () => {
  // We test the linux branch on every host by spoofing process.platform.
  let xdgDir: string;
  let savedXdg: string | undefined;
  let savedWayland: string | undefined;
  let savedDisplay: string | undefined;

  beforeEach(() => {
    xdgDir = join(tmpdir(), `xdg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(xdgDir, { recursive: true });
    savedXdg = process.env.XDG_RUNTIME_DIR;
    savedWayland = process.env.WAYLAND_DISPLAY;
    savedDisplay = process.env.DISPLAY;
  });
  afterEach(() => {
    try { rmSync(xdgDir, { recursive: true, force: true }); } catch {}
    if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = savedXdg;
    if (savedWayland === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = savedWayland;
    if (savedDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = savedDisplay;
  });

  it('returns a copy of process.env (not the same reference)', () => {
    withPlatform('linux', () => {
      const env = inferGraphicalEnv();
      expect(env).not.toBe(process.env);
      expect(env.PATH).toBe(process.env.PATH);
    });
  });

  it('discovers WAYLAND_DISPLAY from a socket file in XDG_RUNTIME_DIR', () => {
    delete process.env.WAYLAND_DISPLAY;
    process.env.XDG_RUNTIME_DIR = xdgDir;
    writeFileSync(join(xdgDir, 'wayland-3'), '');
    withPlatform('linux', () => {
      const env = inferGraphicalEnv();
      expect(env.WAYLAND_DISPLAY).toBe('wayland-3');
    });
  });

  it('does not override an explicit WAYLAND_DISPLAY', () => {
    process.env.WAYLAND_DISPLAY = 'wayland-99';
    process.env.XDG_RUNTIME_DIR = xdgDir;
    writeFileSync(join(xdgDir, 'wayland-3'), '');
    withPlatform('linux', () => {
      expect(inferGraphicalEnv().WAYLAND_DISPLAY).toBe('wayland-99');
    });
  });

  it('does NOT invent WAYLAND_DISPLAY when the dir has no wayland-N socket', () => {
    delete process.env.WAYLAND_DISPLAY;
    process.env.XDG_RUNTIME_DIR = xdgDir;
    writeFileSync(join(xdgDir, 'not-a-wayland-socket'), '');
    withPlatform('linux', () => {
      expect(inferGraphicalEnv().WAYLAND_DISPLAY).toBeUndefined();
    });
  });

  it('preserves an explicit DISPLAY when set', () => {
    process.env.DISPLAY = ':42';
    process.env.XDG_RUNTIME_DIR = xdgDir;
    withPlatform('linux', () => {
      expect(inferGraphicalEnv().DISPLAY).toBe(':42');
    });
  });

  // Smoke test on the real linux host — confirms the spoofed paths above
  // actually match production behaviour. Skipped on non-linux runners.
  it.skipIf(!IS_LINUX)('on a real linux host: returns a non-null env object', () => {
    const env = inferGraphicalEnv();
    expect(env).toBeDefined();
    expect(env).not.toBe(process.env);
  });
});
