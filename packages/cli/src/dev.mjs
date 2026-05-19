// `triscope dev` — proxy to `vite` in the current project.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export async function runDev({ port } = {}) {
  const cwd = process.cwd();
  // Prefer locally-installed vite binary, fall back to PATH.
  const localVite = resolve(cwd, 'node_modules/.bin/vite');
  const vite = existsSync(localVite) ? localVite : 'vite';
  const args = [];
  if (port) args.push('--port', String(port));
  const child = spawn(vite, args, { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}
