// `triscope init <dir>` — thin wrapper around create-triscope so users
// don't have to remember `npm init triscope` vs `npx create-triscope`.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// In a hoisted monorepo install, create-triscope sits next to cli inside
// the same node_modules root. In a published install, it lives at
// `<consumer>/node_modules/create-triscope`. We try both.
export function locateScaffolderBin() {
  const candidates = [
    // monorepo / workspace layout (cli/src/init.mjs → ../../create-triscope)
    resolve(HERE, '../../create-triscope/bin/create.mjs'),
    // hoisted into the consumer's node_modules
    resolve(process.cwd(), 'node_modules/create-triscope/bin/create.mjs'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export async function runInit({ dir, install }) {
  if (!dir) {
    console.error('Usage: triscope init <project-dir> [--install]');
    process.exit(2);
  }
  const target = resolve(process.cwd(), dir);
  // create-triscope itself rejects non-empty dirs; we warn early so the
  // user sees the failure before we spawn the scaffolder. Only the
  // readdirSync call can plausibly fail (permission errors) — handle
  // *that* narrowly instead of wrapping process.exit, which earlier
  // wrapping was silently swallowing.
  if (existsSync(target) && statSync(target).isDirectory()) {
    let entries;
    try { entries = readdirSync(target); } catch { entries = null; }
    if (entries && entries.length > 0) {
      console.error(`refusing: ${target} exists and is not empty`);
      process.exit(2);
    }
  }

  const bin = locateScaffolderBin();
  if (bin) {
    await spawnAndWait(process.execPath, [bin, dir]);
  } else {
    // Fall back to `npm init triscope` so users without the workspace can
    // still bootstrap (npm will fetch create-triscope from the registry).
    await spawnAndWait('npm', ['init', 'triscope', dir]);
  }

  if (install) {
    console.log('');
    console.log(`running \`npm install\` in ${dir}…`);
    await spawnAndWait('npm', ['install'], { cwd: target });
  }
}

function spawnAndWait(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
    p.on('error', rej);
  });
}
