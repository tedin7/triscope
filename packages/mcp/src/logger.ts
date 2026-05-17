/**
 * Structured logger for the MCP server.
 *
 * Two output sinks:
 *   - console.error (the existing convention — readable when run under
 *     Claude Code, doesn't pollute stdout which is the MCP transport)
 *   - /tmp/<project>-mcp.log with naive 1 MB rotation (rename to .1 then
 *     truncate), so a long-running server keeps a persistent error trail
 *     without leaking disk.
 *
 * Each entry is one JSON line:
 *   {"ts":"2026-05-17T15:00:00.000Z","level":"error","scope":"capture",
 *    "msg":"…","meta":{…}}
 *
 * Designed for grep / jq, not for fancy log libraries.
 */
import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  scope: string;
  msg: string;
  meta?: Record<string, unknown>;
}

export interface Logger {
  info(scope: string, msg: string, meta?: Record<string, unknown>): void;
  warn(scope: string, msg: string, meta?: Record<string, unknown>): void;
  error(scope: string, msg: string, meta?: Record<string, unknown>): void;
  debug(scope: string, msg: string, meta?: Record<string, unknown>): void;
  readonly logPath: string;
}

const MAX_LOG_BYTES = 1024 * 1024; // 1 MB

export function createLogger(project: string): Logger {
  const logPath = join(tmpdir(), `${project}-mcp.log`);

  function rotateIfNeeded(): void {
    try {
      if (!existsSync(logPath)) return;
      const size = statSync(logPath).size;
      if (size < MAX_LOG_BYTES) return;
      const rolled = `${logPath}.1`;
      if (existsSync(rolled)) {
        try { unlinkSync(rolled); } catch { /* best-effort */ }
      }
      renameSync(logPath, rolled);
    } catch { /* never let logging crash the server */ }
  }

  function write(entry: LogEntry): void {
    // console (stderr — stdout is taken by MCP stdio transport)
    const tag = `[triscope-mcp:${entry.level}:${entry.scope}]`;
    if (entry.level === 'error' || entry.level === 'warn') {
      // eslint-disable-next-line no-console
      console.error(tag, entry.msg, entry.meta ?? '');
    } else if (process.env.TRISCOPE_MCP_DEBUG) {
      // eslint-disable-next-line no-console
      console.error(tag, entry.msg, entry.meta ?? '');
    }
    // file
    try {
      rotateIfNeeded();
      appendFileSync(logPath, JSON.stringify(entry) + '\n');
    } catch { /* swallow */ }
  }

  function make(level: LogLevel) {
    return (scope: string, msg: string, meta?: Record<string, unknown>) =>
      write({ ts: new Date().toISOString(), level, scope, msg, meta });
  }

  return {
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    debug: make('debug'),
    logPath,
  };
}
