import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'triscope.mjs');

function run(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('triscope CLI bin', () => {
  it('prints help on --help', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/triscope — multi-angle 3D iteration framework/);
    expect(r.stdout).toMatch(/USAGE/);
  });

  it('prints help when invoked with no subcommand', () => {
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/USAGE/);
  });

  it('prints help with -h after a subcommand', () => {
    const r = run(['state', '-h']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/USAGE/);
  });

  it('exits 2 with a usage hint on unknown subcommands', () => {
    const r = run(['notarealcommand']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Unknown command/);
  });
});
