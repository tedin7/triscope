import { describe, expect, it } from 'vitest';
import { parseFlags } from '../src/parse-flags.mjs';

describe('parseFlags — empty / trivial', () => {
  it('returns empty flags + positional for []', () => {
    expect(parseFlags([])).toEqual({ flags: {}, positional: [] });
  });
});

describe('parseFlags — boolean flags', () => {
  it('--help and -h both set flags.help=true', () => {
    expect(parseFlags(['--help']).flags.help).toBe(true);
    expect(parseFlags(['-h']).flags.help).toBe(true);
  });

  it('--project, --no-hook, --install', () => {
    const { flags } = parseFlags(['--project', '--no-hook', '--install']);
    expect(flags.project).toBe(true);
    expect(flags['no-hook']).toBe(true);
    expect(flags.install).toBe(true);
  });
});

describe('parseFlags — value flags consume the next token', () => {
  it('--url, --file, --port, --screenshot all take a value', () => {
    const { flags } = parseFlags([
      '--url',
      'http://x',
      '--file',
      '/a',
      '--port',
      '5500',
      '--screenshot',
      's.png',
    ]);
    expect(flags.url).toBe('http://x');
    expect(flags.file).toBe('/a');
    expect(flags.port).toBe('5500');
    expect(flags.screenshot).toBe('s.png');
  });

  it('a value flag at the end with no following value yields undefined (current behaviour)', () => {
    const { flags } = parseFlags(['--url']);
    expect('url' in flags).toBe(true);
    expect(flags.url).toBeUndefined();
  });

  it('value flags do NOT consume a following flag-looking token as their value (well, they do — documenting current behaviour)', () => {
    // The parser is intentionally simple: `argv[++i]` is taken
    // unconditionally, even if the next token is another flag. This is
    // worth pinning so a refactor doesn't change semantics silently.
    const { flags } = parseFlags(['--url', '--port', '5173']);
    expect(flags.url).toBe('--port');
    // After consuming '--port' as the value of --url, '5173' is positional.
    expect(parseFlags(['--url', '--port', '5173']).positional).toEqual(['5173']);
  });
});

describe('parseFlags — positional vs flag separation', () => {
  it('positional args preserve order and exclude all parsed flags', () => {
    const r = parseFlags(['init', '--install', 'mydir']);
    expect(r.positional).toEqual(['init', 'mydir']);
    expect(r.flags.install).toBe(true);
  });

  it('mixed: positional + value-flag + boolean-flag + positional', () => {
    const r = parseFlags([
      'smoke',
      'ship',
      '--url',
      'http://localhost:5174',
      '--screenshot',
      'out.png',
    ]);
    expect(r.positional).toEqual(['smoke', 'ship']);
    expect(r.flags.url).toBe('http://localhost:5174');
    expect(r.flags.screenshot).toBe('out.png');
  });

  it('numeric-looking values stay as strings (caller decides parsing)', () => {
    const { flags } = parseFlags(['--port', '5173']);
    expect(flags.port).toBe('5173');
    expect(typeof flags.port).toBe('string');
  });
});

describe('parseFlags — unknown flags', () => {
  it('a generic --name value pair becomes flags[name]=value', () => {
    const { flags } = parseFlags(['--whatever', '42']);
    expect(flags.whatever).toBe('42');
  });

  it('an --equals-syntax flag is NOT split (--a=b becomes flags["a=b"]=next-token)', () => {
    // Worth pinning: `--foo=bar` is currently treated as the single flag
    // name "foo=bar" with the next token as its value, NOT as foo=bar.
    const { flags, positional } = parseFlags(['--foo=bar', 'x']);
    expect(flags['foo=bar']).toBe('x');
    expect(positional).toEqual([]);
  });

  it('non-flag short tokens (no leading --) all land in positional', () => {
    expect(parseFlags(['a', 'b', 'c']).positional).toEqual(['a', 'b', 'c']);
  });
});
