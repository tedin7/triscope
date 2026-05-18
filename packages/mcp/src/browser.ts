// Persistent Chromium pool. The MCP server keeps one Chromium child +
// one CDP websocket alive across capture_views / diff_reference calls so
// subsequent captures skip the 3-5 s cold start. First call lazy-spawns;
// later calls navigate the existing page if the URL changed, otherwise reuse.
//
// One pool per MCP process. Disposed on process exit (kill -9 also clears
// the user-data-dir via the OS, since /tmp is volatile).

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from './logger.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_CHROME_ARGS = [
  '--enable-unsafe-webgpu',
  '--ignore-gpu-blocklist',
  // Suppress the first-run wizard and the default-browser banner: both
  // can block the new window from rendering or trigger a different code
  // path that ignores --remote-debugging-port until dismissed. Both have
  // been seen to leave Chromium "running" but with no CDP endpoint open,
  // which manifests as a "DevTools endpoint did not become ready" error.
  '--no-first-run',
  '--no-default-browser-check',
];

function parseExtraChromeArgs(): string[] {
  const raw = process.env.TRISCOPE_CHROME_ARGS ?? '';
  if (!raw.trim()) return [];
  // Keep this intentionally simple: env-configured args are whitespace split.
  // Flags containing spaces should be wrapped in a tiny launcher script and
  // provided via CHROME_BIN instead.
  return raw.trim().split(/\s+/).filter(Boolean);
}

function tailLines(text: string, maxLines = 24): string {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-maxLines).join('\n');
}

async function readDevtoolsPages(port: number): Promise<any[] | null> {
  try {
    const pages = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) }).then((r) => r.json());
    return Array.isArray(pages) && pages.length > 0 ? pages : null;
  } catch {
    return null;
  }
}

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

/**
 * Locate a Chromium-family browser on disk. Resolution order matches
 * puppeteer/playwright so users who already set one of these for their
 * existing tooling don't have to duplicate config:
 *   1. explicit arg
 *   2. CHROME_BIN
 *   3. PUPPETEER_EXECUTABLE_PATH
 *   4. OS-typical defaults (Windows: Program Files\Google\Chrome; macOS:
 *      /Applications/Google Chrome.app; Linux: PATH-relative `chromium`)
 */

function inferGraphicalEnv(): NodeJS.ProcessEnv {
  if (process.platform !== 'linux') return process.env;

  const env: NodeJS.ProcessEnv = { ...process.env };
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const runtimeDir = env.XDG_RUNTIME_DIR || (uid !== undefined ? `/run/user/${uid}` : undefined);

  if (runtimeDir && existsSync(runtimeDir)) {
    env.XDG_RUNTIME_DIR = runtimeDir;
    if (!env.WAYLAND_DISPLAY) {
      try {
        const waylandSocket = readdirSync(runtimeDir).find((name) => /^wayland-\d+$/.test(name));
        if (waylandSocket) env.WAYLAND_DISPLAY = waylandSocket;
      } catch { /* best-effort */ }
    }
  }

  if (!env.DISPLAY && existsSync('/tmp/.X11-unix/X0')) env.DISPLAY = ':0';
  return env;
}

function defaultChromeBinary(): string {
  if (process.platform === 'win32') {
    // Windows users normally install Chrome under Program Files. We don't
    // touch the filesystem to verify — Chrome's own startup will surface
    // an ENOENT clearly enough — but we pick the typical 64-bit path so
    // most installs Just Work without setting CHROME_BIN.
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  return 'chromium';
}

export function createBrowserPool({
  chromeBin = process.env.CHROME_BIN ?? process.env.PUPPETEER_EXECUTABLE_PATH ?? defaultChromeBinary(),
  port = Number(process.env.TRISCOPE_DEBUG_PORT ?? 9230),
  logger = undefined as Logger | undefined,
} = {}) {
  let chrome: ChildProcessWithoutNullStreams | null = null;
  let chromeExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let chromeStderr = '';
  let ws = null;
  let call = null;
  let currentUrl = null;

  async function connectToPage(initialUrl: string, pages: any[]) {
    const page = pages.find((p) => p.url === initialUrl || p.url?.startsWith(initialUrl)) ?? pages[0];
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = (e) => rej(new Error(`ws error: ${e?.message ?? 'unknown'}`));
    });
    call = cdpClient(ws);
    await call('Runtime.enable');
    await call('Page.enable');
    currentUrl = page.url ?? initialUrl;
    if (currentUrl !== initialUrl) await navigateIfNeeded(initialUrl);
  }

  function chromeLaunchArgs(profile: string, initialUrl: string): string[] {
    return [
      ...DEFAULT_CHROME_ARGS,
      ...parseExtraChromeArgs(),
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      '--window-size=1600,900',
      initialUrl,
    ];
  }

  async function ensureBrowser(initialUrl: string) {
    if (chrome && !chrome.killed && ws && ws.readyState === 1) return;

    // First attach to an already-running browser on the configured port. This
    // is the reliable path in sandboxed agents where opening a headed GUI may
    // require a user-approved launcher outside the MCP process.
    const existingPages = await readDevtoolsPages(port);
    if (existingPages) {
      logger?.info('browser', 'attaching to existing DevTools endpoint', { port, pages: existingPages.length });
      await connectToPage(initialUrl, existingPages);
      return;
    }

    // Profile dir: pid + monotonic timestamp + random suffix → unique per
    // spawn so two concurrent MCP servers (or one that respawned after a
    // crash, leaving SingletonLock pointing at a dead PID) can never share
    // the same dir. Chromium's singleton check is path-based — same dir =
    // forwards URL to the "running" instance and exits without binding
    // --remote-debugging-port, which is the silent-fail mode that's hard
    // to diagnose.
    const profile = join(
      tmpdir(),
      `triscope-mcp-profile-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    const args = chromeLaunchArgs(profile, initialUrl);
    chromeExit = null;
    chromeStderr = '';
    const browserEnv = inferGraphicalEnv();
    logger?.info('browser', 'spawning chromium', {
      chromeBin,
      port,
      profile,
      args,
      env: {
        DISPLAY: browserEnv.DISPLAY,
        WAYLAND_DISPLAY: browserEnv.WAYLAND_DISPLAY,
        XDG_RUNTIME_DIR: browserEnv.XDG_RUNTIME_DIR,
      },
    });
    chrome = spawn(chromeBin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: browserEnv });
    chrome.stderr.on('data', (d) => {
      chromeStderr += String(d);
      if (chromeStderr.length > 12000) chromeStderr = chromeStderr.slice(-12000);
    });
    chrome.on('exit', (code, signal) => {
      chromeExit = { code, signal };
      logger?.warn('browser', 'chromium exited', { code, signal, stderr: tailLines(chromeStderr) });
    });
    chrome.on('error', (err) => {
      chromeExit = { code: 1, signal: null };
      chromeStderr += `\nspawn error: ${(err as any)?.message ?? String(err)}`;
      logger?.error('browser', 'chromium spawn error', { message: (err as any)?.message ?? String(err) });
    });

    let pages: any[] | null = null;
    const start = Date.now();
    while (Date.now() - start < 10000) {
      pages = await readDevtoolsPages(port);
      if (pages) break;
      if (chromeExit) break;
      await wait(250);
    }
    if (!pages) {
      const stderr = tailLines(chromeStderr);
      const exit = chromeExit ? ` chromiumExit=${JSON.stringify(chromeExit)}` : '';
      // Silent-exit pattern: chromiumExit is null (process didn't die) but
      // port stayed closed. Almost always: sandboxed Chromium can't bind
      // network ports, or the singleton check forwarded the URL to a
      // (non-debuggable) sibling instance.
      const silentExit = !chromeExit && !pages;
      const hint = silentExit
        ? 'Chromium process is alive but DevTools never opened — usually the host sandbox is blocking the bind on TRISCOPE_DEBUG_PORT, or another Chromium instance is reusing the same profile dir. Workarounds: (1) pre-launch Chrome yourself with --remote-debugging-port=' + port + ' --enable-unsafe-webgpu — the MCP server auto-attaches to an existing endpoint when present; (2) set TRISCOPE_DEBUG_PORT to a port the sandbox permits.'
        : 'If this runs under Codex/Claude and headed launch still fails, pre-launch Chrome with --remote-debugging-port=' + port + ' or set TRISCOPE_CHROME_ARGS=--headless=new for non-interactive capture.';
      throw new Error(`DevTools endpoint did not become ready on 127.0.0.1:${port}.${exit}${stderr ? `\nstderr:\n${stderr}` : ''}\n${hint}`);
    }
    await connectToPage(initialUrl, pages);
  }

  function harnessNotMountedError(url: string) {
    return new Error(
      `window.__TRISCOPE__ did not mount within 10s on ${url}. ` +
      `Common causes: ` +
      `(1) the page never loaded — confirm the dev server is up and the URL is right (open it in a real browser tab); ` +
      `(2) WebGPU init failed — Linux Chrome needs --enable-unsafe-webgpu and either xvfb or a real display; ` +
      `(3) runLab() threw before mounting — check the #boot overlay text or the page console; ` +
      `(4) the lab page doesn't call runLab() at all — verify its entry script imports @triscope/core.`
    );
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
    throw harnessNotMountedError(url);
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
    throw harnessNotMountedError(currentUrl ?? '(initial page)');
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
    ws = null; chrome = null; call = null; currentUrl = null; chromeExit = null; chromeStderr = '';
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
