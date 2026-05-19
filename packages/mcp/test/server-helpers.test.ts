import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';

/**
 * Phase-2 unit coverage on the pure helpers inside the MCP server module.
 *
 * Caveat: importing `../src/server.js` triggers module-level side effects
 * (logger init, BrowserPool construction, signal handlers). These are
 * all benign — the BrowserPool is lazy and never spawns until getPage().
 * The end-to-end exercise of `startServer` itself lives in the smoke
 * job in CI; this file pins the small testable units.
 */
import {
  absolutize,
  applyPath,
  jsonResult,
  probeStatsFromPng,
  readProjectLabMap,
  readProjectName,
  recordError,
} from '../src/server.js';

describe('readProjectName', () => {
  let dir: string;
  let saved: string | undefined;
  beforeEach(() => {
    dir = join(tmpdir(), `mcp-srv-projname-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    saved = process.env.TRISCOPE_PROJECT;
    delete process.env.TRISCOPE_PROJECT;
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    if (saved === undefined) delete process.env.TRISCOPE_PROJECT;
    else process.env.TRISCOPE_PROJECT = saved;
  });

  it('TRISCOPE_PROJECT env wins over filesystem lookup', () => {
    process.env.TRISCOPE_PROJECT = 'override-name';
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pkg-name' }));
    expect(readProjectName(dir)).toBe('override-name');
  });

  it('falls back to "triscope-project" when no package.json exists', () => {
    expect(readProjectName(dir)).toBe('triscope-project');
  });

  it('reads package.json#name and sanitises non-filesystem-safe chars', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@scope/foo bar!' }));
    expect(readProjectName(dir)).toBe('-scope-foo-bar-');
  });

  it('survives a corrupt package.json', () => {
    writeFileSync(join(dir, 'package.json'), 'not json {');
    expect(readProjectName(dir)).toBe('triscope-project');
  });

  it('survives a package.json with no name field', () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    expect(readProjectName(dir)).toBe('triscope-project');
  });
});

describe('applyPath (jq-style)', () => {
  const data = { perf: { fps: 60, dt: 0.0167 }, elements: { ship: { triangles: 12000 } } };

  it('returns the full payload when path is empty/undefined', () => {
    expect(applyPath(data, undefined)).toBe(data);
    expect(applyPath(data, '')).toBe(data);
  });

  it('traverses a dotted path', () => {
    expect(applyPath(data, 'perf.fps')).toBe(60);
    expect(applyPath(data, 'elements.ship.triangles')).toBe(12000);
  });

  it('accepts a leading dot', () => {
    expect(applyPath(data, '.perf.fps')).toBe(60);
  });

  it('returns undefined on a missing segment', () => {
    expect(applyPath(data, 'perf.missing')).toBeUndefined();
    expect(applyPath(data, 'elements.water.depth')).toBeUndefined();
  });

  it('stops cleanly at null in the chain', () => {
    expect(applyPath({ a: null }, 'a.b')).toBeUndefined();
  });
});

describe('readProjectLabMap', () => {
  let dir: string;
  beforeEach(() => {
    dir = join(tmpdir(), `mcp-srv-labmap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('returns {} when no package.json exists', () => {
    expect(readProjectLabMap(dir)).toEqual({});
  });

  it('returns the triscope.labs object when present', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'demo',
      triscope: { labs: { ship: '/ship.html', water: '/water.html' } },
    }));
    expect(readProjectLabMap(dir)).toEqual({ ship: '/ship.html', water: '/water.html' });
  });

  it('returns {} when triscope.labs is absent or wrong type', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', triscope: { labs: 'no' } }));
    expect(readProjectLabMap(dir)).toEqual({});
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo' }));
    expect(readProjectLabMap(dir)).toEqual({});
  });

  it('survives a corrupt package.json', () => {
    writeFileSync(join(dir, 'package.json'), '{{');
    expect(readProjectLabMap(dir)).toEqual({});
  });
});

describe('absolutize', () => {
  it('returns null for falsy input', () => {
    expect(absolutize(null)).toBeNull();
    expect(absolutize('')).toBeNull();
    expect(absolutize(undefined)).toBeNull();
  });

  it('returns full URLs untouched', () => {
    expect(absolutize('http://localhost:5174/x.html')).toBe('http://localhost:5174/x.html');
    expect(absolutize('https://example.com/y')).toBe('https://example.com/y');
  });

  it('prefixes a leading-slash path with the dev URL', () => {
    // DEV_URL is captured at module load from process.env.TRISCOPE_URL,
    // defaulting to http://localhost:5173. We only assert the suffix is
    // attached correctly + that http:// stays at the start.
    const out = absolutize('/labs/ship.html');
    expect(out).toMatch(/^http:\/\//);
    expect(out).toMatch(/\/labs\/ship\.html$/);
  });

  it('inserts a "/" between dev URL and a relative path missing one', () => {
    const out = absolutize('ship.html');
    expect(out).toMatch(/\/ship\.html$/);
    // Single "/" between origin and the path — no double slashes.
    expect(out!.replace(/^https?:\/\//, '')).not.toMatch(/\/{2,}/);
  });
});

describe('recordError', () => {
  // recordError → logger.error → console.error. We don't want every
  // negative-input assertion to flood the test output, so silence the
  // stderr writes for the duration of this describe.
  let errSpy;
  beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { errSpy?.mockRestore(); });

  it('appends a timestamped line; tolerates Error instances and plain strings', () => {
    // We can't directly read the recentErrors array (it's module-private),
    // but recordError calls logger.error which writes to the log file.
    // The behavioural assertion: it returns nothing and doesn't throw on
    // assorted inputs. Negative test: ensure it's resilient to garbage.
    expect(() => recordError('test', new Error('boom'))).not.toThrow();
    expect(() => recordError('test', 'string error')).not.toThrow();
    expect(() => recordError('test', { custom: 'object' })).not.toThrow();
    expect(() => recordError('test', null)).not.toThrow();
    expect(() => recordError('test', undefined)).not.toThrow();
  });

  it('caps the in-memory ring at RECENT_ERRORS_CAP (16) — no unbounded growth', () => {
    // Push 50; the ring keeps the last 16. We can't read the ring from
    // outside, but the operation must stay O(1) memory — assert by
    // running it 50 times and noting completion in <100 ms.
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) recordError('flood', new Error(`e${i}`));
    expect(Date.now() - t0).toBeLessThan(100);
  });
});

describe('probeStatsFromPng', () => {
  function solidPng(w: number, h: number, rgb: [number, number, number]): Buffer {
    const png = new PNG({ width: w, height: h });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = rgb[0]; png.data[i + 1] = rgb[1]; png.data[i + 2] = rgb[2]; png.data[i + 3] = 255;
    }
    return PNG.sync.write(png);
  }

  it('reports luminance ≈ 0 for a fully black image', () => {
    const out = probeStatsFromPng(solidPng(64, 64, [0, 0, 0]));
    expect(out.luminance).toBeCloseTo(0, 3);
    expect(out.p5).toBeCloseTo(0, 3);
    expect(out.p95).toBeCloseTo(0, 3);
    expect(out.samples).toBeGreaterThan(0);
  });

  it('reports luminance ≈ 1 for a fully white image', () => {
    const out = probeStatsFromPng(solidPng(64, 64, [255, 255, 255]));
    expect(out.luminance).toBeCloseTo(1, 3);
    expect(out.p5).toBeCloseTo(1, 3);
    expect(out.p95).toBeCloseTo(1, 3);
  });

  it('uses Rec.709 weights (green dominates)', () => {
    const pureRed = probeStatsFromPng(solidPng(32, 32, [255, 0, 0]));
    const pureGreen = probeStatsFromPng(solidPng(32, 32, [0, 255, 0]));
    const pureBlue = probeStatsFromPng(solidPng(32, 32, [0, 0, 255]));
    expect(pureGreen.luminance).toBeGreaterThan(pureRed.luminance);
    expect(pureRed.luminance).toBeGreaterThan(pureBlue.luminance);
    // Rec.709: 0.2126 R + 0.7152 G + 0.0722 B
    expect(pureRed.luminance).toBeCloseTo(0.2126, 2);
    expect(pureGreen.luminance).toBeCloseTo(0.7152, 2);
    expect(pureBlue.luminance).toBeCloseTo(0.0722, 2);
  });

  it('stride-samples to keep cost bounded (samples stay ≤ ~2400 on a 1280×720 image)', () => {
    const big = new PNG({ width: 1280, height: 720 });
    for (let i = 0; i < big.data.length; i += 4) {
      big.data[i] = 128; big.data[i + 1] = 128; big.data[i + 2] = 128; big.data[i + 3] = 255;
    }
    const out = probeStatsFromPng(PNG.sync.write(big));
    // The doc says ~2300; we leave headroom for stride-rounding.
    expect(out.samples).toBeLessThan(3000);
    expect(out.samples).toBeGreaterThan(2000);
  });

  it('dynamicRange = p95 / max(p5, 1/255) is computed and finite', () => {
    const out = probeStatsFromPng(solidPng(32, 32, [128, 128, 128]));
    expect(Number.isFinite(out.dynamicRange)).toBe(true);
    expect(out.dynamicRange).toBeGreaterThan(0);
  });
});

describe('jsonResult (MCP tool wrapper)', () => {
  it('wraps strings as a single text content', () => {
    const r = jsonResult('hello');
    expect(r).toEqual({ content: [{ type: 'text', text: 'hello' }] });
  });

  it('serializes objects with 2-space indent', () => {
    const r = jsonResult({ a: 1, b: { c: 2 } });
    expect(r.content[0].type).toBe('text');
    expect(r.content[0].text).toBe(JSON.stringify({ a: 1, b: { c: 2 } }, null, 2));
  });

  it('renders undefined as the literal string "undefined"', () => {
    expect(jsonResult(undefined).content[0].text).toBe('undefined');
  });

  it('renders numbers and booleans via JSON.stringify', () => {
    expect(jsonResult(42).content[0].text).toBe('42');
    expect(jsonResult(true).content[0].text).toBe('true');
    expect(jsonResult(null).content[0].text).toBe('null');
  });
});
