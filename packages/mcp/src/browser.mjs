// Persistent Chromium pool. The MCP server keeps one Chromium child +
// one CDP websocket alive across capture_views / diff_reference calls so
// subsequent captures skip the 3-5 s cold start. First call lazy-spawns;
// later calls navigate the existing page if the URL changed, otherwise reuse.
//
// One pool per MCP process. Disposed on process exit (kill -9 also clears
// the user-data-dir via the OS, since /tmp is volatile).

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function cdpClient(ws) {
  const pending = new Map();
  let nextId = 0;
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params }));
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout for ${method}`));
      }, 20000);
      pending.set(id, (msg) => {
        clearTimeout(t);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg);
      });
    });
  return call;
}

export function createBrowserPool({
  chromeBin = process.env.CHROME_BIN ?? 'chromium',
  port = Number(process.env.TRISCOPE_DEBUG_PORT ?? 9230),
} = {}) {
  let chrome = null;
  let ws = null;
  let call = null;
  let currentUrl = null;

  async function ensureBrowser(initialUrl) {
    if (chrome && !chrome.killed && ws && ws.readyState === 1) return;
    const profile = join(tmpdir(), `triscope-mcp-profile-${process.pid}`);
    chrome = spawn(chromeBin, [
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      '--window-size=1600,900',
      initialUrl,
    ]);
    let pages;
    const start = Date.now();
    while (Date.now() - start < 10000) {
      try {
        pages = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
        if (Array.isArray(pages) && pages.length > 0) break;
      } catch {}
      await wait(250);
    }
    if (!pages) throw new Error('DevTools endpoint did not become ready');
    const page = pages.find((p) => p.url === initialUrl || p.url?.startsWith(initialUrl)) ?? pages[0];
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = (e) => rej(new Error(`ws error: ${e?.message ?? 'unknown'}`));
    });
    call = cdpClient(ws);
    await call('Runtime.enable');
    await call('Page.enable');
    currentUrl = initialUrl;
  }

  async function navigateIfNeeded(url) {
    if (url === currentUrl) return;
    await call('Page.navigate', { url });
    // Wait for the harness to remount on the new page.
    const start = Date.now();
    while (Date.now() - start < 10000) {
      try {
        const probe = await call('Runtime.evaluate', {
          expression: '!!window.__TRISCOPE__ && Object.keys(window.__TRISCOPE__.cameras).length',
          returnByValue: true,
        });
        if (probe.result.result.value) { currentUrl = url; return; }
      } catch {}
      await wait(200);
    }
    throw new Error(`window.__TRISCOPE__ did not become available within 10s on ${url}`);
  }

  async function waitForHarness() {
    for (let i = 0; i < 40; i++) {
      const probe = await call('Runtime.evaluate', {
        expression: '!!window.__TRISCOPE__ && Object.keys(window.__TRISCOPE__.cameras).length',
        returnByValue: true,
      });
      if (probe.result.result.value) return;
      await wait(250);
    }
    throw new Error('window.__TRISCOPE__ did not become available within 10s');
  }

  async function isAlive() {
    if (!chrome || chrome.killed || !ws || ws.readyState !== 1) return false;
    // Even with WS open, the page may be hung. Probe with a fast no-op
    // CDP call and short timeout so a stalled Chromium is detected here
    // rather than at the much heavier Page.navigate that follows.
    try {
      await Promise.race([
        call('Runtime.evaluate', { expression: '1', returnByValue: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('alive probe timeout')), 1500)),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  function disposeQuiet() {
    try { ws?.close(); } catch {}
    try { if (chrome && !chrome.killed) chrome.kill(); } catch {}
    ws = null; chrome = null; call = null; currentUrl = null;
  }

  return {
    /** Lazy-spawn Chromium (first call) or reuse it (subsequent). Always
     *  guarantees the page is sitting on `url` with the harness mounted.
     *  Self-heals: if the previous Chromium died externally (manual kill,
     *  crash) the next call disposes the stale state and respawns. */
    async getPage(url) {
      if (chrome && !(await isAlive())) {
        disposeQuiet();
      }
      if (!chrome) {
        await ensureBrowser(url);
        await waitForHarness();
      } else {
        await navigateIfNeeded(url);
      }
      return { call };
    },
    /** Synchronous teardown. Safe to call multiple times. */
    dispose() { disposeQuiet(); },
  };
}
