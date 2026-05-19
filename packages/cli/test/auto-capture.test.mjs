import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELEVANT, fmt, readProjectName, runAutoCapture } from '../src/auto-capture.mjs';

describe('fmt', () => {
  it('formats finite numbers to 2 decimals', () => {
    expect(fmt(1.2345)).toBe('1.23');
    expect(fmt(0)).toBe('0.00');
  });
  it('returns ? for non-finite', () => {
    expect(fmt(Infinity)).toBe('?');
    expect(fmt(NaN)).toBe('?');
  });
});

describe('RELEVANT regex', () => {
  it('matches 3D-related filenames', () => {
    expect(RELEVANT.test('/src/Ship.element.ts')).toBe(true);
    expect(RELEVANT.test('/src/water-shader.ts')).toBe(true);
    expect(RELEVANT.test('/src/scene/index.ts')).toBe(true);
    expect(RELEVANT.test('/labs/foo.html')).toBe(true);
  });
  it('does NOT match unrelated files', () => {
    expect(RELEVANT.test('/src/util.ts')).toBe(false);
    expect(RELEVANT.test('README.md')).toBe(false);
  });
});

describe('readProjectName', () => {
  it('falls back when package.json is absent', () => {
    expect(readProjectName('/nonexistent-cwd-xyz')).toBe('triscope-project');
  });
});

describe('runAutoCapture', () => {
  let dir;
  let origCwd;
  let logSpy;

  beforeEach(() => {
    dir = join(tmpdir(), `triscope-cli-autocap-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demoauto' }));
    origCwd = process.cwd();
    process.chdir(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(origCwd);
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    try { rmSync(join(tmpdir(), 'demoauto-state.json'), { force: true }); } catch {}
    logSpy.mockRestore();
  });

  it('stays silent when --file is irrelevant', async () => {
    await runAutoCapture({ file: '/etc/passwd' });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('stays silent when no state file exists', async () => {
    await runAutoCapture({});
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('stays silent on corrupt state JSON', async () => {
    writeFileSync(join(tmpdir(), 'demoauto-state.json'), '{{');
    await runAutoCapture({});
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('stays silent when there are no elements/motion entries', async () => {
    writeFileSync(join(tmpdir(), 'demoauto-state.json'), JSON.stringify({ perf: {} }));
    await runAutoCapture({});
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('prints one line per element with motion + fps when present', async () => {
    writeFileSync(join(tmpdir(), 'demoauto-state.json'), JSON.stringify({
      perf: { fps: 59.83 },
      elements: {
        ship: { motion: { hull: { peakToPeak: 1.23, dominantFreqHz: 2.45 } } },
        water: { motion: { wave: { peakToPeak: 0.5, dominantFreqHz: 1.1 } } },
      },
    }));
    await runAutoCapture({});
    const printed = logSpy.mock.calls[0][0];
    expect(printed).toMatch(/fps=59\.83/);
    expect(printed).toMatch(/ship motion: hull p2p=1\.23 freq=2\.45Hz/);
    expect(printed).toMatch(/water motion: wave p2p=0\.50 freq=1\.10Hz/);
  });
});
