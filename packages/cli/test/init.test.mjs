import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateScaffolderBin, runInit } from '../src/init.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'triscope.mjs');

describe('locateScaffolderBin', () => {
  it('finds the workspace-sibling create-triscope bin in this monorepo', () => {
    const bin = locateScaffolderBin();
    expect(bin).not.toBeNull();
    expect(existsSync(bin)).toBe(true);
    expect(bin).toMatch(/create-triscope[\\/]bin[\\/]create\.mjs$/);
  });
});

/**
 * runInit in-process: covers the early validation + happy-path dispatch
 * code. The subprocess-based tests below are the ones that actually
 * validate end-to-end semantics (real exit codes, real filesystem) —
 * these in-process tests pad coverage and pin the dispatch shape.
 */
describe('runInit (in-process)', () => {
  let exitSpy;
  let errSpy;
  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit:${code}`); });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('exits 2 with a "Usage:" message when no dir is passed', async () => {
    await expect(runInit({})).rejects.toThrow(/exit:2/);
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/Usage:/));
  });

  it('happy path: scaffolds into a fresh dir (uses the real bundled template)', async () => {
    const target = join(tmpdir(), `triscope-init-inproc-${process.pid}-${Date.now()}`);
    try {
      await runInit({ dir: target });
      expect(existsSync(join(target, 'package.json'))).toBe(true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('exits 2 with "refusing" when target exists and is non-empty', async () => {
    const target = join(tmpdir(), `triscope-init-nonempty-${process.pid}-${Date.now()}`);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'sentinel'), 'x');
    try {
      await expect(runInit({ dir: target })).rejects.toThrow(/exit:2/);
      expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/refusing/));
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

/**
 * runInit calls process.exit(2) inside a try/catch that swallows
 * synchronous throws — so a vi.spyOn(process, 'exit') based test gives
 * misleading results. We run the bin as a real subprocess instead: the
 * actual process truly exits, and we observe stderr + exit code as a user
 * would.
 */
describe('triscope init (real subprocess)', () => {
  let TMP;
  beforeEach(() => {
    TMP = join(tmpdir(), `triscope-init-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

  it('exits 2 with usage when no dir is given', () => {
    const r = spawnSync(process.execPath, [BIN, 'init'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Usage:/);
  });

  it('exits non-zero when the target directory exists and is non-empty', () => {
    const target = join(TMP, 'occupied');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'sentinel'), 'x');
    const r = spawnSync(process.execPath, [BIN, 'init', target], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/refusing|Refusing/);
  });

  it('scaffolds a fresh project end-to-end into a clean dir', () => {
    const target = join(TMP, 'fresh');
    const r = spawnSync(process.execPath, [BIN, 'init', target], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Scaffolded/);
    expect(existsSync(join(target, 'package.json'))).toBe(true);
  });
});
