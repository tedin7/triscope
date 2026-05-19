import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import {
  composeFilmstrip,
  composeSideBySide,
  decodePng,
  diffReference,
  diffReferenceMotion,
  meanAbsDiff,
  motionMagnitudeFromFrames,
  nearestNeighborResize,
  refsMotionPaths,
  refsPath,
  setReference,
  setReferenceMotion,
  ssim,
} from '../src/refs.js';

/**
 * Refs.ts is pure image math + filesystem. Tests build solid-colour PNGs
 * on the fly so we don't need any binary fixtures.
 */
function solidPng(w: number, h: number, rgb: [number, number, number]): { png: PNG; base64: string } {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = 255;
  }
  const buf = PNG.sync.write(png);
  return { png, base64: buf.toString('base64') };
}

function gradientPng(w: number, h: number): string {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      png.data[i] = (x * 255) / Math.max(1, w - 1);
      png.data[i + 1] = (y * 255) / Math.max(1, h - 1);
      png.data[i + 2] = 128;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png).toString('base64');
}

const TMP_BASE = join(tmpdir(), `triscope-refs-test-${process.pid}`);
let cwd: string;

beforeEach(() => {
  cwd = join(TMP_BASE, String(Date.now()) + Math.random().toString(36).slice(2, 8));
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => {
  try { rmSync(cwd, { recursive: true, force: true }); } catch {}
});

describe('refsPath / refsMotionPaths', () => {
  it('routes elements + cameras under cwd/refs/<element>/<safeCamera>', () => {
    expect(refsPath('/root', 'ship', 'bow')).toBe(join('/root', 'refs', 'ship', 'bow.png'));
  });

  it('sanitises camera names that contain unsafe path characters', () => {
    expect(refsPath('/root', 'ship', '../bow/with spaces')).toBe(
      join('/root', 'refs', 'ship', '.._bow_with_spaces.png'),
    );
  });

  it('refsMotionPaths returns matching filmstrip and meta paths', () => {
    const out = refsMotionPaths('/root', 'ship', 'bow');
    expect(out.filmstrip).toBe(join('/root', 'refs', 'ship', 'bow.motion.png'));
    expect(out.meta).toBe(join('/root', 'refs', 'ship', 'bow.motion.json'));
  });
});

describe('nearestNeighborResize', () => {
  it('returns the same instance when dimensions already match', () => {
    const { png } = solidPng(4, 4, [10, 20, 30]);
    expect(nearestNeighborResize(png, 4, 4)).toBe(png);
  });

  it('resizes a 2x2 to 4x4 while preserving rgb values', () => {
    const { png } = solidPng(2, 2, [50, 100, 150]);
    const out = nearestNeighborResize(png, 4, 4);
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
    // Every pixel should be 50,100,150,255.
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(50);
      expect(out.data[i + 1]).toBe(100);
      expect(out.data[i + 2]).toBe(150);
      expect(out.data[i + 3]).toBe(255);
    }
  });
});

describe('meanAbsDiff', () => {
  it('returns 0 for identical solid images', () => {
    const a = solidPng(8, 8, [128, 128, 128]).png;
    const b = solidPng(8, 8, [128, 128, 128]).png;
    expect(meanAbsDiff(a, b)).toBe(0);
  });

  it('returns ~255 for black-vs-white', () => {
    const a = solidPng(8, 8, [0, 0, 0]).png;
    const b = solidPng(8, 8, [255, 255, 255]).png;
    expect(meanAbsDiff(a, b)).toBeCloseTo(255, 0);
  });

  it('returns a proportional value for a known per-channel delta', () => {
    const a = solidPng(8, 8, [100, 100, 100]).png;
    const b = solidPng(8, 8, [110, 90, 100]).png;
    // (|10|+|10|+|0|) / 3 ≈ 6.67
    expect(meanAbsDiff(a, b)).toBeGreaterThan(6);
    expect(meanAbsDiff(a, b)).toBeLessThan(7);
  });
});

describe('ssim', () => {
  it('returns ~1 for identical images', () => {
    const a = solidPng(64, 64, [200, 50, 50]).png;
    const b = solidPng(64, 64, [200, 50, 50]).png;
    expect(ssim(a, b)).toBeGreaterThan(0.99);
  });

  it('drops sharply for visually different images', () => {
    const a = decodePng(Buffer.from(gradientPng(64, 64), 'base64'));
    const b = solidPng(64, 64, [255, 255, 255]).png;
    expect(ssim(a, b)).toBeLessThan(0.8);
  });

  it('stays in the documented [-1, 1] range', () => {
    const a = solidPng(32, 32, [0, 0, 0]).png;
    const b = solidPng(32, 32, [255, 255, 255]).png;
    const s = ssim(a, b);
    expect(s).toBeGreaterThanOrEqual(-1);
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe('composeSideBySide', () => {
  it('joins two images horizontally with a 4-px separator', () => {
    const a = solidPng(10, 10, [255, 0, 0]).png;
    const b = solidPng(10, 10, [0, 0, 255]).png;
    const out = composeSideBySide(a, b);
    expect(out.height).toBe(10);
    expect(out.width).toBe(10 + 4 + 10);
  });

  it('handles asymmetric heights by matching to the smaller', () => {
    const a = solidPng(20, 40, [255, 0, 0]).png;
    const b = solidPng(20, 20, [0, 255, 0]).png;
    const out = composeSideBySide(a, b);
    expect(out.height).toBe(20);
  });
});

describe('composeFilmstrip', () => {
  it('throws on empty input', () => {
    expect(() => composeFilmstrip([])).toThrow(/no frames/);
  });

  it('tiles N frames horizontally with a separator and returns a Buffer', () => {
    const frames = [
      solidPng(20, 30, [255, 0, 0]).base64,
      solidPng(20, 30, [0, 255, 0]).base64,
      solidPng(20, 30, [0, 0, 255]).base64,
    ];
    const buf = composeFilmstrip(frames);
    expect(Buffer.isBuffer(buf)).toBe(true);
    const decoded = decodePng(buf);
    expect(decoded.height).toBe(30);
    // 3 frames @ 20px wide + 2 separators @ 2px = 64
    expect(decoded.width).toBe(20 * 3 + 2 * 2);
  });

  it('honours a custom separator width', () => {
    const frames = [
      solidPng(10, 10, [0, 0, 0]).base64,
      solidPng(10, 10, [0, 0, 0]).base64,
    ];
    const buf = composeFilmstrip(frames, { sep: 8 });
    const decoded = decodePng(buf);
    expect(decoded.width).toBe(10 + 8 + 10);
  });

  it('tolerates base64 with the data-uri prefix', () => {
    const frame = `data:image/png;base64,${solidPng(8, 8, [10, 20, 30]).base64}`;
    expect(() => composeFilmstrip([frame, frame])).not.toThrow();
  });
});

describe('motionMagnitudeFromFrames', () => {
  it('returns 0 for <2 frames', () => {
    expect(motionMagnitudeFromFrames([])).toBe(0);
    expect(motionMagnitudeFromFrames([solidPng(8, 8, [0, 0, 0]).base64])).toBe(0);
  });

  it('returns 0 for identical frames', () => {
    const f = solidPng(16, 16, [128, 128, 128]).base64;
    expect(motionMagnitudeFromFrames([f, f, f])).toBe(0);
  });

  it('returns >0 when consecutive frames differ', () => {
    const a = solidPng(16, 16, [0, 0, 0]).base64;
    const b = solidPng(16, 16, [255, 255, 255]).base64;
    expect(motionMagnitudeFromFrames([a, b, a, b])).toBeGreaterThan(100);
  });
});

describe('setReference / diffReference', () => {
  it('setReference rejects when neither path nor base64 is provided', () => {
    expect(() => setReference({ cwd, element: 'ship', camera: 'bow' })).toThrow(/path or base64/);
  });

  it('setReference rejects when element or camera is missing', () => {
    expect(() => setReference({ cwd, element: '', camera: 'bow', base64: 'x' })).toThrow();
    expect(() => setReference({ cwd, element: 'ship', camera: '', base64: 'x' })).toThrow();
  });

  it('setReference rejects when path does not exist', () => {
    expect(() => setReference({ cwd, element: 'ship', camera: 'bow', path: '/nope.png' })).toThrow(/not found/);
  });

  it('setReference writes the PNG and returns the path', () => {
    const { base64 } = solidPng(8, 8, [10, 20, 30]);
    const out = setReference({ cwd, element: 'ship', camera: 'bow', base64 });
    expect(existsSync(out.path)).toBe(true);
    expect(out.bytes).toBeGreaterThan(0);
  });

  it('setReference tolerates data-uri prefix', () => {
    const { base64 } = solidPng(8, 8, [1, 2, 3]);
    const out = setReference({ cwd, element: 'ship', camera: 'bow', base64: `data:image/png;base64,${base64}` });
    expect(existsSync(out.path)).toBe(true);
  });

  it('diffReference throws when no reference exists', () => {
    expect(() =>
      diffReference({ cwd, element: 'ship', camera: 'bow', currentBase64: solidPng(8, 8, [0, 0, 0]).base64 }),
    ).toThrow(/no reference/);
  });

  it('diffReference throws when currentBase64 is missing', () => {
    setReference({ cwd, element: 'ship', camera: 'bow', base64: solidPng(8, 8, [0, 0, 0]).base64 });
    expect(() => diffReference({ cwd, element: 'ship', camera: 'bow', currentBase64: '' })).toThrow(/currentBase64/);
  });

  it('diffReference returns 0 meanAbsDiff and high ssim for identical frames', () => {
    const ref = solidPng(32, 32, [99, 99, 99]).base64;
    setReference({ cwd, element: 'ship', camera: 'bow', base64: ref });
    const out = diffReference({ cwd, element: 'ship', camera: 'bow', currentBase64: ref });
    expect(out.meanAbsDiff).toBe(0);
    expect(out.ssim).toBeGreaterThan(0.99);
    expect(out.refPath).toMatch(/ship\/bow\.png$/);
    expect(out.compositeBase64.length).toBeGreaterThan(0);
  });

  it('diffReference returns a high mean-diff for very different frames', () => {
    setReference({ cwd, element: 'ship', camera: 'bow', base64: solidPng(32, 32, [0, 0, 0]).base64 });
    const out = diffReference({
      cwd, element: 'ship', camera: 'bow', currentBase64: solidPng(32, 32, [255, 255, 255]).base64,
    });
    expect(out.meanAbsDiff).toBeGreaterThan(200);
  });
});

describe('setReferenceMotion / diffReferenceMotion', () => {
  it('setReferenceMotion requires >=2 frames', () => {
    expect(() => setReferenceMotion({ cwd, element: 'ship', camera: 'bow', frameBase64s: [], meta: {} })).toThrow(/at least 2/);
  });

  it('setReferenceMotion writes filmstrip + meta', () => {
    const frames = [solidPng(8, 8, [0, 0, 0]).base64, solidPng(8, 8, [255, 255, 255]).base64];
    const out = setReferenceMotion({ cwd, element: 'ship', camera: 'bow', frameBase64s: frames, meta: { fps: 60 } });
    expect(existsSync(out.filmstripPath)).toBe(true);
    expect(existsSync(out.metaPath)).toBe(true);
    const meta = JSON.parse(readFileSync(out.metaPath, 'utf8'));
    expect(meta.frames).toBe(2);
    expect(meta.fps).toBe(60);
    expect(typeof meta.savedAt).toBe('string');
  });

  it('diffReferenceMotion throws when no motion reference exists', () => {
    expect(() => diffReferenceMotion({
      cwd, element: 'ship', camera: 'bow',
      currentFrames: [solidPng(8, 8, [0, 0, 0]).base64, solidPng(8, 8, [0, 0, 0]).base64],
    })).toThrow(/no motion reference/);
  });

  it('diffReferenceMotion throws when currentFrames is empty', () => {
    const frames = [solidPng(8, 8, [0, 0, 0]).base64, solidPng(8, 8, [255, 255, 255]).base64];
    setReferenceMotion({ cwd, element: 'ship', camera: 'bow', frameBase64s: frames, meta: {} });
    expect(() => diffReferenceMotion({ cwd, element: 'ship', camera: 'bow', currentFrames: [] })).toThrow(/non-empty/);
  });

  it('diffReferenceMotion returns 0 diff for identical filmstrips', () => {
    const frames = [solidPng(16, 16, [50, 50, 50]).base64, solidPng(16, 16, [100, 100, 100]).base64];
    setReferenceMotion({ cwd, element: 'ship', camera: 'bow', frameBase64s: frames, meta: { fps: 30 } });
    const out = diffReferenceMotion({ cwd, element: 'ship', camera: 'bow', currentFrames: frames });
    expect(out.motionDiff).toBe(0);
    expect(out.refMeta?.fps).toBe(30);
    expect(out.compositeBase64.length).toBeGreaterThan(0);
  });

  it('diffReferenceMotion reports >0 diff for different filmstrips', () => {
    const ref = [solidPng(16, 16, [0, 0, 0]).base64, solidPng(16, 16, [10, 10, 10]).base64];
    const cur = [solidPng(16, 16, [200, 200, 200]).base64, solidPng(16, 16, [250, 250, 250]).base64];
    setReferenceMotion({ cwd, element: 'ship', camera: 'bow', frameBase64s: ref, meta: {} });
    const out = diffReferenceMotion({ cwd, element: 'ship', camera: 'bow', currentFrames: cur });
    expect(out.motionDiff).toBeGreaterThan(100);
  });

  it('diffReferenceMotion tolerates a missing meta json', () => {
    const frames = [solidPng(8, 8, [0, 0, 0]).base64, solidPng(8, 8, [255, 255, 255]).base64];
    setReferenceMotion({ cwd, element: 'ship', camera: 'bow', frameBase64s: frames, meta: {} });
    // Delete the meta file to simulate a corrupt/incomplete reference.
    rmSync(refsMotionPaths(cwd, 'ship', 'bow').meta);
    const out = diffReferenceMotion({ cwd, element: 'ship', camera: 'bow', currentFrames: frames });
    expect(out.refMeta).toBeNull();
  });
});
