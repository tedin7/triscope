import { describe, expect, it } from 'vitest';
import { parseFlags } from '../src/parse-flags.mjs';

describe('parseFlags', () => {
  it('returns empty flags + positional for []', () => {
    expect(parseFlags([])).toEqual({ flags: {}, positional: [] });
  });

  it('handles --help and -h as flags.help=true', () => {
    expect(parseFlags(['--help']).flags.help).toBe(true);
    expect(parseFlags(['-h']).flags.help).toBe(true);
  });

  it('handles boolean flags --project, --no-hook, --install', () => {
    const { flags } = parseFlags(['--project', '--no-hook', '--install']);
    expect(flags.project).toBe(true);
    expect(flags['no-hook']).toBe(true);
    expect(flags.install).toBe(true);
  });

  it('handles value flags --url, --file, --port, --screenshot', () => {
    const { flags } = parseFlags(['--url', 'http://x', '--file', '/tmp/a', '--port', '5500', '--screenshot', 'shot.png']);
    expect(flags.url).toBe('http://x');
    expect(flags.file).toBe('/tmp/a');
    expect(flags.port).toBe('5500');
    expect(flags.screenshot).toBe('shot.png');
  });

  it('captures positional args in order, after dropping flags', () => {
    const { positional } = parseFlags(['init', '--install', 'mydir']);
    expect(positional).toEqual(['init', 'mydir']);
  });

  it('accepts unknown --flags as generic key/value pairs', () => {
    const { flags } = parseFlags(['--whatever', '42']);
    expect(flags.whatever).toBe('42');
  });
});
