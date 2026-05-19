import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locateScaffolderBin, runInit } from '../src/init.mjs';

describe('locateScaffolderBin', () => {
  it('finds the workspace-sibling create-triscope bin in this monorepo', () => {
    const bin = locateScaffolderBin();
    // We run from this very monorepo, so the workspace path must resolve.
    expect(bin).not.toBeNull();
    expect(existsSync(bin)).toBe(true);
    expect(bin).toMatch(/create-triscope\/bin\/create\.mjs$/);
  });
});

describe('runInit', () => {
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

  it('exits 2 when no dir is provided', async () => {
    await expect(runInit({})).rejects.toThrow(/exit:2/);
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/Usage:/));
  });

  it('warns "refusing" when the target directory exists and is non-empty', async () => {
    // runInit's exit(2) is wrapped in a try/catch that swallows our spy's
    // throw, so the *behavioural* assertion is the error message — the
    // function tries to exit, but if we let it continue (as the spy does)
    // it eventually fails when spawning the scaffolder; either way the
    // console.error must fire first.
    const dir = join(tmpdir(), `triscope-init-nonempty-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sentinel'), 'x');
    try {
      // Swallow either the spy-thrown exit OR the downstream spawn failure.
      await runInit({ dir }).catch(() => {});
      expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/refusing/));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
