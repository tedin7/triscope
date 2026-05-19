import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDir, main } from '../bin/create.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'create.mjs');

/**
 * The scaffolder is "copy a template dir, do __PROJECT_NAME__ substitution
 * in text files, leave binary files untouched". We build a synthetic
 * template in a tmpdir so the test stays independent of whatever the
 * actual `template/` shipped on disk happens to contain.
 */
let base;
let templateDir;
let outDir;

beforeEach(() => {
  base = join(tmpdir(), `triscope-create-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  templateDir = join(base, 'template');
  outDir = join(base, 'out');
  mkdirSync(templateDir, { recursive: true });
});
afterEach(() => {
  try { rmSync(base, { recursive: true, force: true }); } catch {}
});

describe('copyDir', () => {
  it('copies a flat directory and substitutes __PROJECT_NAME__ in text files', () => {
    writeFileSync(join(templateDir, 'package.json'), JSON.stringify({ name: '__PROJECT_NAME__' }));
    writeFileSync(join(templateDir, 'README.md'), 'Welcome to __PROJECT_NAME__');
    copyDir(templateDir, outDir, { __PROJECT_NAME__: 'my-app' });
    expect(JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8')).name).toBe('my-app');
    expect(readFileSync(join(outDir, 'README.md'), 'utf8')).toBe('Welcome to my-app');
  });

  it('recurses into subdirectories', () => {
    mkdirSync(join(templateDir, 'src', 'inner'), { recursive: true });
    writeFileSync(join(templateDir, 'src', 'inner', 'a.ts'), 'export const NAME = "__PROJECT_NAME__";');
    copyDir(templateDir, outDir, { __PROJECT_NAME__: 'nested' });
    expect(readFileSync(join(outDir, 'src', 'inner', 'a.ts'), 'utf8'))
      .toBe('export const NAME = "nested";');
  });

  it('leaves non-text files (e.g. binary) untouched and intact', () => {
    const binary = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03]);
    writeFileSync(join(templateDir, 'logo.png'), binary);
    copyDir(templateDir, outDir, { __PROJECT_NAME__: 'whatever' });
    expect(readFileSync(join(outDir, 'logo.png'))).toEqual(binary);
  });

  it('handles multiple substitutions in one file', () => {
    writeFileSync(join(templateDir, 'config.json'), '{"a":"__PROJECT_NAME__","b":"__PROJECT_NAME__"}');
    copyDir(templateDir, outDir, { __PROJECT_NAME__: 'twice' });
    expect(readFileSync(join(outDir, 'config.json'), 'utf8')).toBe('{"a":"twice","b":"twice"}');
  });

  it('only touches files with whitelisted text extensions', () => {
    // .bin is not in the allowlist — substitution must be skipped even
    // though the file content would otherwise contain the marker.
    writeFileSync(join(templateDir, 'data.bin'), '__PROJECT_NAME__');
    copyDir(templateDir, outDir, { __PROJECT_NAME__: 'replaced' });
    expect(readFileSync(join(outDir, 'data.bin'), 'utf8')).toBe('__PROJECT_NAME__');
  });

  it('creates an empty destination directory when the template is empty', () => {
    copyDir(templateDir, outDir, {});
    expect(existsSync(outDir)).toBe(true);
    expect(readdirSync(outDir)).toEqual([]);
  });
});

describe('main() called in-process (covers the script body)', () => {
  let origArgv;
  let origCwd;
  let exitSpy;
  let logSpy;
  let errSpy;

  beforeEach(() => {
    origArgv = process.argv;
    origCwd = process.cwd();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit:${code}`); });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    process.argv = origArgv;
    process.chdir(origCwd);
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('exits 2 + prints usage when argv[2] is missing', () => {
    process.argv = [process.execPath, 'create.mjs'];
    expect(() => main()).toThrow(/exit:2/);
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/Usage:/));
  });

  it('exits 2 when target dir is non-empty', () => {
    const target = join(base, 'occupied-inproc');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'x'), 'x');
    process.argv = [process.execPath, 'create.mjs', target];
    expect(() => main()).toThrow(/exit:2/);
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/Refusing/));
  });

  it('happy path: scaffolds and prints next-step hints', () => {
    const target = join(base, 'fresh-inproc');
    process.argv = [process.execPath, 'create.mjs', target];
    main();
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Scaffolded/));
    expect(existsSync(join(target, 'package.json'))).toBe(true);
  });

  it('sanitises the project name (basename with unsafe chars)', () => {
    const target = join(base, 'My Weird@Name');
    process.argv = [process.execPath, 'create.mjs', target];
    main();
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('My-Weird-Name');
  });
});

describe('create.mjs invoked as a script', () => {
  it('exits 2 with usage when no argument is provided', () => {
    const r = spawnSync(process.execPath, [BIN], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Usage:/);
  });

  it('exits 2 when target directory exists and is non-empty', () => {
    const target = join(base, 'occupied');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'sentinel'), 'x');
    const r = spawnSync(process.execPath, [BIN, target], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Refusing/);
  });

  it('scaffolds the bundled template into a fresh dir', () => {
    const target = join(base, 'fresh');
    const r = spawnSync(process.execPath, [BIN, target], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Scaffolded/);
    // package.json from the real template ships with __PROJECT_NAME__;
    // assert it got substituted with the basename of `target`.
    expect(existsSync(join(target, 'package.json'))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('fresh');
  });
});
