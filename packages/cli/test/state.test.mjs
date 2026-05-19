import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPath, readProjectName, runState } from '../src/state.mjs';

describe('applyPath', () => {
  const data = { a: { b: { c: 42 } }, list: [1, 2] };
  it('returns the full object for empty/undefined path', () => {
    expect(applyPath(data, undefined)).toBe(data);
    expect(applyPath(data, '')).toBe(data);
  });
  it('traverses a dotted path', () => {
    expect(applyPath(data, 'a.b.c')).toBe(42);
  });
  it('accepts a leading dot (jq-style)', () => {
    expect(applyPath(data, '.a.b.c')).toBe(42);
  });
  it('returns undefined on missing segment', () => {
    expect(applyPath(data, 'a.x.c')).toBeUndefined();
  });
  it('stops cleanly at null in the chain', () => {
    expect(applyPath({ a: null }, 'a.b')).toBeUndefined();
  });
});

describe('readProjectName', () => {
  let dir;
  beforeEach(() => {
    dir = join(tmpdir(), `triscope-cli-state-test-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it('falls back to triscope-project when no package.json', () => {
    expect(readProjectName(dir)).toBe('triscope-project');
  });

  it('reads package.json#name and sanitises it', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@scope/foo bar' }));
    expect(readProjectName(dir)).toBe('-scope-foo-bar');
  });

  it('falls back when package.json is corrupt', () => {
    writeFileSync(join(dir, 'package.json'), '{{ not json');
    expect(readProjectName(dir)).toBe('triscope-project');
  });
});

describe('runState', () => {
  let dir;
  let origCwd;
  let exitSpy;
  let logSpy;
  let errSpy;

  beforeEach(() => {
    dir = join(tmpdir(), `triscope-cli-runstate-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo' }));
    origCwd = process.cwd();
    process.chdir(dir);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(origCwd);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(join(tmpdir(), 'demo-state.json'), { force: true });
    } catch {}
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('exits 1 when state file is absent', async () => {
    await expect(runState({})).rejects.toThrow(/exit:1/);
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/No telemetry/));
  });

  it('exits 2 when path is not found', async () => {
    writeFileSync(join(tmpdir(), 'demo-state.json'), JSON.stringify({ a: 1 }));
    await expect(runState({ path: '.missing' })).rejects.toThrow(/exit:2/);
  });

  it('prints scalar values directly, objects as JSON', async () => {
    writeFileSync(
      join(tmpdir(), 'demo-state.json'),
      JSON.stringify({ perf: { fps: 60 }, name: 'ok' }),
    );
    await runState({ path: '.perf.fps' });
    expect(logSpy).toHaveBeenCalledWith(60);
    logSpy.mockClear();
    await runState({ path: '.perf' });
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/"fps": 60/));
  });
});
