// `triscope mcp install|uninstall` — wraps `claude mcp add/remove`.
//
// Resolves the absolute path of the @triscope/mcp bin via Node's resolver, so
// it works whether triscope is installed as a dep, linked, or run from this
// monorepo. Falls back to a sibling `packages/mcp/bin/triscope-mcp.mjs` for
// the monorepo case where the bin isn't on PATH.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_NAME = 'triscope';
const DEFAULT_URL = 'http://localhost:5173';

function resolveServerBin() {
  // Try the workspace sibling first (monorepo dev case).
  const here = dirname(fileURLToPath(import.meta.url));
  const sibling = resolve(here, '../../mcp/bin/triscope-mcp.mjs');
  if (existsSync(sibling)) return sibling;

  // Fall back to Node resolution from the consumer project's cwd.
  try {
    const req = createRequire(join(process.cwd(), 'package.json'));
    const pkgJson = req.resolve('@triscope/mcp/package.json');
    return resolve(dirname(pkgJson), 'bin/triscope-mcp.mjs');
  } catch {
    return null;
  }
}

function hasClaudeCli() {
  const r = spawnSync('claude', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

function runClaude(args) {
  const r = spawnSync('claude', args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`claude ${args.join(' ')} exited ${r.status}`);
}

function writeProjectMcpJson(bin, url) {
  const path = join(process.cwd(), '.mcp.json');
  let existing = {};
  if (existsSync(path)) {
    try { existing = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  }
  existing.mcpServers ??= {};
  existing.mcpServers[SERVER_NAME] = {
    command: 'node',
    args: [bin],
    env: { TRISCOPE_URL: url },
  };
  writeFileSync(path, JSON.stringify(existing, null, 2) + '\n');
  return path;
}

function removeFromProjectMcpJson() {
  const path = join(process.cwd(), '.mcp.json');
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!data?.mcpServers?.[SERVER_NAME]) return null;
  delete data.mcpServers[SERVER_NAME];
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  return path;
}

export async function runMcp({ action, scope = 'user', url = DEFAULT_URL }) {
  if (!action || action === 'help') {
    console.log(`triscope mcp <install|uninstall> [--project] [--url <url>]

  install              Register the triscope MCP server with Claude Code
                       (default: user scope, so it's available in every chat).
  install --project    Write/merge .mcp.json in the current directory instead
                       (project-scoped, shared with collaborators if committed).
  uninstall            Remove the triscope MCP registration matching --scope.

OPTIONS
  --project            Use project scope (.mcp.json in cwd) instead of user.
  --url <url>          Override TRISCOPE_URL env (default ${DEFAULT_URL}).
`);
    return;
  }

  const bin = resolveServerBin();
  if (!bin) {
    throw new Error(
      'Could not locate @triscope/mcp. Install triscope (e.g. `npm i @triscope/mcp`) or run from the monorepo.',
    );
  }
  try { statSync(bin); } catch {
    throw new Error(`@triscope/mcp bin not found at ${bin}`);
  }

  if (action === 'install') {
    if (scope === 'project') {
      const path = writeProjectMcpJson(bin, url);
      console.log(`wrote project-scoped registration to ${path}`);
      console.log('restart Claude Code in this directory to pick it up.');
      return;
    }
    if (!hasClaudeCli()) {
      throw new Error(
        'claude CLI not on PATH. Install Claude Code, or run `triscope mcp install --project`.',
      );
    }
    runClaude([
      'mcp', 'add', SERVER_NAME,
      '--scope', 'user',
      '--env', `TRISCOPE_URL=${url}`,
      '--', 'node', bin,
    ]);
    console.log(`\ntriscope registered (user scope). bin: ${bin}`);
    return;
  }

  if (action === 'uninstall') {
    if (scope === 'project') {
      const path = removeFromProjectMcpJson();
      if (path) console.log(`removed triscope from ${path}`);
      else console.log('no project-scoped triscope entry found.');
      return;
    }
    if (!hasClaudeCli()) throw new Error('claude CLI not on PATH.');
    runClaude(['mcp', 'remove', SERVER_NAME, '--scope', 'user']);
    return;
  }

  throw new Error(`Unknown mcp action: ${action}`);
}
