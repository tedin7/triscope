// `triscope auto-capture` — minimal hook-friendly status print.
//
// Designed to be wired as a Claude Code PostToolUse hook that runs after
// every Edit. Reads /tmp/<project>-state.json (already maintained by the
// dev server) and prints a one-line motion summary per element that has
// motionProbes declared. Cheap: no Chromium spawn, just a file read.
//
// Hook config example (settings.json or .claude/settings.local.json):
//   {
//     "hooks": {
//       "PostToolUse": [{
//         "matcher": "Edit|Write",
//         "hooks": [{ "type": "command", "command": "triscope auto-capture" }]
//       }]
//     }
//   }
//
// Optional `--file <path>` arg: filter so the hook only prints when an
// edited file likely affects 3D state. Falls back to printing always.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function readProjectName(cwd) {
  try {
    const pkgPath = join(cwd, 'package.json');
    if (!existsSync(pkgPath)) return 'triscope-project';
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return String(pkg.name ?? 'triscope-project').replace(/[^A-Za-z0-9._-]/g, '-');
  } catch {
    return 'triscope-project';
  }
}

export const RELEVANT = /\b(triscope|lab|scene|element|shader|mesh)/i;

export function fmt(n) {
  if (!Number.isFinite(n)) return '?';
  return Number(n).toFixed(2);
}

export async function runAutoCapture({ file } = {}) {
  // If a file path was passed and it doesn't look like 3D code, exit silently.
  if (file && !RELEVANT.test(file)) return;

  const project = readProjectName(process.cwd());
  const statePath = join(tmpdir(), `${project}-state.json`);
  if (!existsSync(statePath)) {
    // No dev server running — the hook just stays quiet.
    return;
  }
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return;
  }
  const elements = state?.elements;
  if (!elements || typeof elements !== 'object') return;

  const lines = [];
  for (const [name, payload] of Object.entries(elements)) {
    const motion = payload?.motion;
    if (!motion || typeof motion !== 'object') continue;
    const probes = Object.entries(motion)
      .filter(([, s]) => s && typeof s === 'object')
      .map(([k, s]) => `${k} p2p=${fmt(s.peakToPeak)} freq=${fmt(s.dominantFreqHz)}Hz`)
      .join(', ');
    if (probes) lines.push(`[triscope] ${name} motion: ${probes}`);
  }
  if (state?.perf?.fps != null) lines.unshift(`[triscope] fps=${fmt(state.perf.fps)}`);
  if (lines.length > 0) console.log(lines.join('\n'));
}
