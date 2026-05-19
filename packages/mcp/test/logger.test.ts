import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../src/logger.js';

const PROJECT = `triscope-logger-test-${process.pid}`;
const LOG_PATH = join(tmpdir(), `${PROJECT}-mcp.log`);
const ROLLED_PATH = `${LOG_PATH}.1`;

function cleanup() {
  for (const p of [LOG_PATH, ROLLED_PATH]) {
    try { rmSync(p, { force: true }); } catch {}
  }
}

beforeEach(cleanup);
afterEach(cleanup);

describe('createLogger', () => {
  it('returns a Logger with info/warn/error/debug + logPath', () => {
    const log = createLogger(PROJECT);
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.debug).toBe('function');
    expect(log.logPath).toBe(LOG_PATH);
  });

  it('appends one JSON line per call with ts/level/scope/msg', () => {
    const log = createLogger(PROJECT);
    log.info('boot', 'starting', { pid: 123 });
    log.warn('browser', 'flaky', { count: 2 });
    const lines = readFileSync(LOG_PATH, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0]);
    const b = JSON.parse(lines[1]);
    expect(a).toMatchObject({ level: 'info', scope: 'boot', msg: 'starting', meta: { pid: 123 } });
    expect(b).toMatchObject({ level: 'warn', scope: 'browser', msg: 'flaky' });
    expect(typeof a.ts).toBe('string');
    expect(() => new Date(a.ts)).not.toThrow();
  });

  it('writes warn/error to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createLogger(PROJECT);
    log.warn('x', 'a');
    log.error('y', 'b');
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('does NOT write info/debug to console.error unless TRISCOPE_MCP_DEBUG is set', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.TRISCOPE_MCP_DEBUG;
    const log = createLogger(PROJECT);
    log.info('x', 'quiet');
    log.debug('x', 'quiet');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('writes info/debug to console.error when TRISCOPE_MCP_DEBUG is set', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.TRISCOPE_MCP_DEBUG = '1';
    try {
      const log = createLogger(PROJECT);
      log.info('x', 'loud');
      expect(spy).toHaveBeenCalled();
    } finally {
      delete process.env.TRISCOPE_MCP_DEBUG;
    }
    spy.mockRestore();
  });

  it('rotates the log to .1 when it crosses 1 MB', () => {
    // Pre-seed a log file just over 1 MB.
    mkdirSync(tmpdir(), { recursive: true });
    writeFileSync(LOG_PATH, 'x'.repeat(1024 * 1024 + 10));
    const log = createLogger(PROJECT);
    log.info('boot', 'after rotation');
    expect(existsSync(ROLLED_PATH)).toBe(true);
    // New log starts fresh, with our latest line only.
    const fresh = readFileSync(LOG_PATH, 'utf8').trim().split('\n');
    expect(fresh).toHaveLength(1);
    expect(JSON.parse(fresh[0]).msg).toBe('after rotation');
  });

  it('overwrites a stale .1 when rotating', () => {
    writeFileSync(ROLLED_PATH, 'old');
    writeFileSync(LOG_PATH, 'x'.repeat(1024 * 1024 + 10));
    const log = createLogger(PROJECT);
    log.info('boot', 'rotated again');
    // .1 should contain the prior 1 MB content, not "old".
    expect(statSync(ROLLED_PATH).size).toBeGreaterThan(1024);
  });

  it('does not throw when meta is omitted', () => {
    const log = createLogger(PROJECT);
    expect(() => log.error('x', 'no meta')).not.toThrow();
    const line = JSON.parse(readFileSync(LOG_PATH, 'utf8').trim());
    expect(line.meta).toBeUndefined();
  });
});
