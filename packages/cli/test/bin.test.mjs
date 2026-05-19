import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'triscope.mjs');

function run(args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
    cwd: opts.cwd,
  });
}

describe('triscope bin — help & dispatch', () => {
  it('prints help on --help', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/triscope — multi-angle 3D iteration framework/);
    expect(r.stdout).toMatch(/COMMANDS/);
  });

  it('prints help when invoked with no subcommand', () => {
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/COMMANDS/);
  });

  it('subcommand -h short-circuits to help before executing the subcommand', () => {
    // If `state -h` actually executed `state`, it would exit 1 with
    // "No telemetry found …". Help-first means it must exit 0.
    const r = run(['state', '-h']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/COMMANDS/);
  });

  it('exits 2 with a usage hint on unknown subcommands', () => {
    const r = run(['notarealcommand']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Unknown command/);
    expect(r.stdout).toMatch(/COMMANDS/);
  });
});

describe('triscope bin — `state` end-to-end against a real fixture', () => {
  // Override TMPDIR + cwd so the bin reads our pre-baked state.json
  // and uses our pre-baked package.json#name. This drives the
  // bin → src/state.mjs → fs → stdout flow as the user would see it,
  // not just the helpers in isolation.
  let TMP;
  let CWD;
  let STATE;

  beforeEach(() => {
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    TMP = join(tmpdir(), `triscope-bin-state-${stamp}`);
    CWD = join(TMP, 'project');
    mkdirSync(CWD, { recursive: true });
    writeFileSync(join(CWD, 'package.json'), JSON.stringify({ name: 'pkgbin' }));
    STATE = join(TMP, 'pkgbin-state.json');
  });
  afterEach(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

  it('exits 1 + warns when no state file exists', () => {
    const r = run(['state'], { env: { TMPDIR: TMP }, cwd: CWD });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/No telemetry/);
  });

  it('prints the full payload as JSON when no path is given', () => {
    writeFileSync(STATE, JSON.stringify({ perf: { fps: 60 }, elements: {} }));
    const r = run(['state'], { env: { TMPDIR: TMP }, cwd: CWD });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/"fps": 60/);
  });

  it('prints a scalar slice when the path resolves to a primitive', () => {
    writeFileSync(STATE, JSON.stringify({ perf: { fps: 59.83 } }));
    const r = run(['state', '.perf.fps'], { env: { TMPDIR: TMP }, cwd: CWD });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('59.83');
  });

  it('exits 2 when the path is not present in the payload', () => {
    writeFileSync(STATE, JSON.stringify({ perf: { fps: 60 } }));
    const r = run(['state', '.missing.path'], { env: { TMPDIR: TMP }, cwd: CWD });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not found/);
  });
});

describe('triscope bin — `list` end-to-end', () => {
  it('exits 1 when the dev server URL is unreachable (network error)', () => {
    // Point at a port nothing is listening on. Use a short fetch timeout
    // via an unreachable host so we don't depend on the OS.
    const r = run(['list', '--url', 'http://127.0.0.1:1'], {});
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Could not reach/);
  });
});

describe('triscope bin — `auto-capture` end-to-end', () => {
  let TMP;
  let CWD;
  let STATE;

  beforeEach(() => {
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    TMP = join(tmpdir(), `triscope-bin-ac-${stamp}`);
    CWD = join(TMP, 'project');
    mkdirSync(CWD, { recursive: true });
    writeFileSync(join(CWD, 'package.json'), JSON.stringify({ name: 'pkgac' }));
    STATE = join(TMP, 'pkgac-state.json');
  });
  afterEach(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

  it('stays silent and exits 0 when there is no state file', () => {
    const r = run(['auto-capture'], { env: { TMPDIR: TMP }, cwd: CWD });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('prints one motion line per element + fps when state has motion probes', () => {
    writeFileSync(STATE, JSON.stringify({
      perf: { fps: 60 },
      elements: { ship: { motion: { hull: { peakToPeak: 1.5, dominantFreqHz: 0.8 } } } },
    }));
    const r = run(['auto-capture'], { env: { TMPDIR: TMP }, cwd: CWD });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/fps=60\.00/);
    expect(r.stdout).toMatch(/ship motion: hull p2p=1\.50 freq=0\.80Hz/);
  });

  it('--file with an unrelated path suppresses the print entirely', () => {
    writeFileSync(STATE, JSON.stringify({
      perf: { fps: 60 },
      elements: { ship: { motion: { hull: { peakToPeak: 1.5, dominantFreqHz: 0.8 } } } },
    }));
    const r = run(['auto-capture', '--file', '/etc/passwd'], { env: { TMPDIR: TMP }, cwd: CWD });
    expect(r.stdout).toBe('');
  });
});

describe('triscope bin — `mcp help`', () => {
  it('prints the mcp-specific help and exits 0', () => {
    const r = run(['mcp']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/triscope mcp <install\|uninstall>/);
  });
});
