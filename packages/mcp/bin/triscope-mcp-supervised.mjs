#!/usr/bin/env node
/**
 * Supervisor wrapper for triscope-mcp.
 *
 * Claude Code spawns this bin as a stdio MCP server. The wrapper itself
 * doesn't speak MCP — it spawns the real triscope-mcp.mjs as a child with
 * inherited stdio (so the child's stdin/stdout are the wrapper's, which
 * are Claude Code's pipes). When the child exits unexpectedly the wrapper
 * respawns it with exponential backoff, keeping the wrapper PID alive and
 * stable from Claude Code's perspective.
 *
 * Why this exists: `claude mcp list` reports "Connected" based on config,
 * not on the actual subprocess being alive. If the real server crashes
 * mid-session (rogue exception, memory blow-up, signal), Claude Code does
 * NOT auto-restart it — subsequent tool calls return cryptic "Connection
 * closed" errors and the user has to exit + relaunch the whole CLI.
 *
 * To use, re-register the MCP pointing at THIS bin instead of the bare
 * server:
 *
 *   claude mcp add triscope-supervised \
 *     --scope user \
 *     --env TRISCOPE_URL=http://localhost:5173 \
 *     -- node /home/.../packages/mcp/bin/triscope-mcp-supervised.mjs
 *
 * Exit semantics:
 *   - Child exits with code 0 or by SIGTERM/SIGINT → wrapper exits too
 *     (clean shutdown, no respawn).
 *   - Child crashes → wrapper respawns with 0.5s → 30s exponential backoff.
 *   - Wrapper's stdin closes → Claude Code disconnected → kill child + exit.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_BIN = join(HERE, 'triscope-mcp.mjs');
const MAX_BACKOFF_MS = 30000;
const RESET_BACKOFF_AFTER_MS = 5000;

let child = null;
let backoff = 0;
let shuttingDown = false;
let resetTimer = null;

function startChild() {
  if (shuttingDown) return;
  // eslint-disable-next-line no-console
  console.error(`[triscope-supervisor] spawning ${REAL_BIN} (backoff=${backoff}ms)`);
  child = spawn('node', [REAL_BIN], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: process.env,
  });
  child.on('exit', (code, sig) => {
    child = null;
    if (resetTimer) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }
    if (shuttingDown) {
      process.exit(code ?? 0);
      return;
    }
    if (sig === 'SIGTERM' || sig === 'SIGINT' || code === 0) {
      // Treat clean exits as "shutdown intent" — don't respawn.
      process.exit(code ?? 0);
      return;
    }
    // eslint-disable-next-line no-console
    console.error(
      `[triscope-supervisor] child exited code=${code} sig=${sig}, respawning in ${backoff || 500}ms`,
    );
    backoff = Math.min(backoff === 0 ? 500 : backoff * 2, MAX_BACKOFF_MS);
    setTimeout(startChild, backoff);
  });
  child.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[triscope-supervisor] child spawn error:', err?.message ?? err);
  });
  // If the child lives more than 5 s, reset the backoff so the next crash
  // gets a fresh 500ms start (avoids permanent slow-restart on a single
  // late crash after a long healthy stretch).
  resetTimer = setTimeout(() => {
    backoff = 0;
  }, RESET_BACKOFF_AFTER_MS);
}

function shutdown(code = 0) {
  shuttingDown = true;
  if (child && !child.killed) {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
  // Give the child a moment to flush before exiting the wrapper.
  setTimeout(() => process.exit(code), 200);
}

// Parent (Claude Code) closed stdin → we should die.
process.stdin.on('end', () => shutdown(0));
process.stdin.on('close', () => shutdown(0));
process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
// Don't crash on our own rogue errors either.
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[triscope-supervisor] uncaughtException:', err?.stack ?? err);
});
process.on('unhandledRejection', (err) => {
  // eslint-disable-next-line no-console
  console.error('[triscope-supervisor] unhandledRejection:', err?.stack ?? err);
});

startChild();
