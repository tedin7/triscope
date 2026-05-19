import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  autoCaptureCommand,
  mergeHook,
  removeFromProjectMcpJson,
  resolveCliBin,
  resolveServerBin,
  runMcp,
  settingsPathForScope,
  triscopeHookSpec,
  unmergeHook,
  writeProjectMcpJson,
} from '../src/mcp.mjs';

describe('resolveServerBin / resolveCliBin', () => {
  it('resolveServerBin finds the workspace-sibling triscope-mcp bin', () => {
    const bin = resolveServerBin();
    expect(bin).not.toBeNull();
    expect(bin).toMatch(/triscope-mcp\.mjs$/);
  });
  it("resolveCliBin points at this package's bin/triscope.mjs", () => {
    expect(resolveCliBin()).toMatch(/bin\/triscope\.mjs$/);
  });
});

describe('autoCaptureCommand', () => {
  it('returns a command string that wires the TOOL_INPUT_file_path env var', () => {
    expect(autoCaptureCommand()).toMatch(/auto-capture --file "\$\{TOOL_INPUT_file_path:-\}"/);
  });
});

describe('runMcp dispatcher', () => {
  it('prints help when action is undefined or "help"', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runMcp({});
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/triscope mcp <install\|uninstall>/));
    log.mockClear();
    await runMcp({ action: 'help' });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('throws on an unknown action', async () => {
    await expect(runMcp({ action: 'frobnicate' })).rejects.toThrow(/Unknown mcp action/);
  });

  it('install --project writes .mcp.json + the hook into the cwd, end-to-end', async () => {
    // We isolate the cwd into a tmpdir so the test never pollutes the
    // monorepo. The scope-project branch needs no `claude` CLI on PATH,
    // so this is a real exercise of the install dispatch path (resolve
    // server bin → write project mcp.json → mergeHook).
    const dir = join(tmpdir(), `triscope-runmcp-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const origCwd = process.cwd();
    process.chdir(dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runMcp({
        action: 'install',
        scope: 'project',
        url: 'http://localhost:9999',
        withHook: true,
      });
      const mcpJson = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
      expect(mcpJson.mcpServers.triscope.command).toBe('node');
      expect(mcpJson.mcpServers.triscope.env.TRISCOPE_URL).toBe('http://localhost:9999');
      // Hook merged into the project-local settings file.
      const settings = JSON.parse(
        readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'),
      );
      expect(settings.hooks.PostToolUse.some((e) => e._triscope === true)).toBe(true);
    } finally {
      process.chdir(origCwd);
      log.mockRestore();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('install --project --no-hook skips the settings merge', async () => {
    const dir = join(tmpdir(), `triscope-runmcp-nohook-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const origCwd = process.cwd();
    process.chdir(dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runMcp({ action: 'install', scope: 'project', url: 'http://x', withHook: false });
      expect(existsSync(join(dir, '.mcp.json'))).toBe(true);
      expect(existsSync(join(dir, '.claude', 'settings.local.json'))).toBe(false);
    } finally {
      process.chdir(origCwd);
      log.mockRestore();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('uninstall --project removes both the registration and the hook', async () => {
    const dir = join(tmpdir(), `triscope-runmcp-uninst-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const origCwd = process.cwd();
    process.chdir(dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runMcp({ action: 'install', scope: 'project', url: 'http://x' });
      expect(existsSync(join(dir, '.mcp.json'))).toBe(true);
      await runMcp({ action: 'uninstall', scope: 'project' });
      const mcpJson = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
      expect(mcpJson.mcpServers.triscope).toBeUndefined();
      const settings = JSON.parse(
        readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'),
      );
      expect(settings.hooks.PostToolUse.some((e) => e._triscope === true)).toBe(false);
    } finally {
      process.chdir(origCwd);
      log.mockRestore();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });
});

describe('triscopeHookSpec', () => {
  it('returns the documented hook shape', () => {
    const spec = triscopeHookSpec();
    expect(spec.matcher).toBe('Edit|Write');
    expect(spec._triscope).toBe(true);
    expect(spec.hooks).toHaveLength(1);
    expect(spec.hooks[0].type).toBe('command');
    expect(spec.hooks[0].command).toMatch(/triscope auto-capture/);
  });
});

describe('settingsPathForScope', () => {
  it('project scope → cwd/.claude/settings.local.json', () => {
    expect(settingsPathForScope('project')).toBe(
      join(process.cwd(), '.claude', 'settings.local.json'),
    );
  });
  it('user scope → homedir/.claude/settings.json', () => {
    expect(settingsPathForScope('user')).toBe(join(homedir(), '.claude', 'settings.json'));
  });
});

describe('writeProjectMcpJson / removeFromProjectMcpJson', () => {
  let dir;
  let origCwd;
  beforeEach(() => {
    dir = join(tmpdir(), `triscope-cli-mcp-test-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    origCwd = process.cwd();
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(origCwd);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it('write creates a new .mcp.json with the triscope entry', () => {
    const path = writeProjectMcpJson('/bin/server.mjs', 'http://localhost:5555');
    expect(path).toBe(join(dir, '.mcp.json'));
    const data = JSON.parse(readFileSync(path, 'utf8'));
    expect(data.mcpServers.triscope.command).toBe('node');
    expect(data.mcpServers.triscope.args).toEqual(['/bin/server.mjs']);
    expect(data.mcpServers.triscope.env.TRISCOPE_URL).toBe('http://localhost:5555');
  });

  it('write merges into an existing .mcp.json without losing other entries', () => {
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
    );
    writeProjectMcpJson('/bin/srv.mjs', 'http://x');
    const data = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    expect(data.mcpServers.other.command).toBe('x');
    expect(data.mcpServers.triscope.command).toBe('node');
  });

  it('remove deletes the entry and returns the path', () => {
    writeProjectMcpJson('/bin/srv.mjs', 'http://x');
    const path = removeFromProjectMcpJson();
    expect(path).toBe(join(dir, '.mcp.json'));
    const data = JSON.parse(readFileSync(path, 'utf8'));
    expect(data.mcpServers.triscope).toBeUndefined();
  });

  it('remove returns null when there is nothing to remove', () => {
    expect(removeFromProjectMcpJson()).toBeNull();
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
    );
    expect(removeFromProjectMcpJson()).toBeNull();
  });
});

describe('mergeHook / unmergeHook (project scope, isolated cwd)', () => {
  let dir;
  let origCwd;
  beforeEach(() => {
    dir = join(tmpdir(), `triscope-cli-mcphook-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    origCwd = process.cwd();
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(origCwd);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it('first mergeHook creates the settings file and reports added=true', () => {
    const r = mergeHook('project');
    expect(r.path).toBe(join(dir, '.claude', 'settings.local.json'));
    expect(r.added).toBe(true);
    expect(existsSync(r.path)).toBe(true);
    const data = JSON.parse(readFileSync(r.path, 'utf8'));
    expect(data.hooks.PostToolUse).toHaveLength(1);
    expect(data.hooks.PostToolUse[0]._triscope).toBe(true);
  });

  it('repeated mergeHook is idempotent (added=false on the second call)', () => {
    mergeHook('project');
    const r = mergeHook('project');
    expect(r.added).toBe(false);
    const data = JSON.parse(readFileSync(r.path, 'utf8'));
    expect(data.hooks.PostToolUse).toHaveLength(1);
  });

  it('unmergeHook removes the entry and reports removed=true', () => {
    mergeHook('project');
    const r = unmergeHook('project');
    expect(r.removed).toBe(true);
    const data = JSON.parse(readFileSync(r.path, 'utf8'));
    expect(data.hooks.PostToolUse).toEqual([]);
  });

  it('unmergeHook is safe when no settings file exists', () => {
    const r = unmergeHook('project');
    expect(r.removed).toBe(false);
  });

  it('mergeHook refuses to write to a malformed JSON file', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.local.json'), '{ not json');
    expect(() => mergeHook('project')).toThrow(/malformed/);
  });

  it('mergeHook preserves unrelated PostToolUse entries', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'settings.local.json'),
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo other' }] }],
        },
      }),
    );
    mergeHook('project');
    const data = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'));
    expect(data.hooks.PostToolUse).toHaveLength(2);
    expect(data.hooks.PostToolUse[0].hooks[0].command).toBe('echo other');
  });
});
