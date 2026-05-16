// `triscope state [<jq-style path>]` — read /tmp/<project>-state.json.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function readProjectName(cwd) {
  try {
    const pkgPath = join(cwd, 'package.json');
    if (!existsSync(pkgPath)) return 'triscope-project';
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return String(pkg.name ?? 'triscope-project').replace(/[^A-Za-z0-9._-]/g, '-');
  } catch {
    return 'triscope-project';
  }
}

function applyPath(data, path) {
  if (!path) return data;
  const segs = path.replace(/^\./, '').split('.').filter(Boolean);
  let cur = data;
  for (const s of segs) {
    if (cur == null) return undefined;
    cur = cur[s];
  }
  return cur;
}

export async function runState({ path }) {
  const project = readProjectName(process.cwd());
  const statePath = join(tmpdir(), `${project}-state.json`);
  if (!existsSync(statePath)) {
    console.error(`No telemetry found at ${statePath}. Is the dev server running?`);
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(statePath, 'utf8'));
  const slice = applyPath(data, path);
  if (slice === undefined) {
    console.error(`Path "${path}" not found in telemetry.`);
    process.exit(2);
  }
  if (slice === null || typeof slice !== 'object') {
    console.log(slice);
  } else {
    console.log(JSON.stringify(slice, null, 2));
  }
}
