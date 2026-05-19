import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runList } from '../src/list.mjs';

describe('runList', () => {
  let exitSpy;
  let logSpy;
  let errSpy;
  let fetchSpy;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    if (fetchSpy) fetchSpy.mockRestore();
  });

  it('exits 1 when fetch throws (server down)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(runList({})).rejects.toThrow(/exit:1/);
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/Could not reach/));
  });

  it('exits 1 when the response is non-ok', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await expect(runList({})).rejects.toThrow(/exit:1/);
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/returned 500/));
  });

  it('exits 2 when manifest is null (no lab loaded yet)', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => null });
    await expect(runList({})).rejects.toThrow(/exit:2/);
  });

  it('prints the manifest JSON when present', async () => {
    const manifest = { elements: { ship: { labUrl: '/ship.html' } } };
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => manifest });
    await runList({});
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(manifest, null, 2));
  });

  it('respects a custom url, stripping trailing slashes', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await runList({ url: 'http://localhost:9999/' });
    expect(fetchSpy).toHaveBeenCalledWith('http://localhost:9999/__manifest');
  });
});
