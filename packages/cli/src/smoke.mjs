// `triscope smoke [<element>]` — headed-Chromium smoke test against a lab page.
// Generalised from water3d's scripts/visual-webgpu.mjs.
//
// Spawns Chrome with WebGPU enabled, opens the lab URL, asserts:
//  - navigator.gpu is available
//  - boot overlay is gone
//  - canvas dimensions are positive
//  - the lab posted a manifest (window.__TRISCOPE__ is present)
//  - no console errors fired
//  - pixel variance + nonBlack ratio cross thresholds
//
// On success: writes a screenshot to /tmp/<project>-smoke-<element>.png and
// prints a JSON summary. Exit 0 on pass, non-zero on fail.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PNG } from 'pngjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function readProjectName(cwd) {
  try {
    const p = join(cwd, 'package.json');
    if (!existsSync(p)) return 'triscope-project';
    const pkg = JSON.parse(readFileSync(p, 'utf8'));
    return String(pkg.name ?? 'triscope-project').replace(/[^A-Za-z0-9._-]/g, '-');
  } catch {
    return 'triscope-project';
  }
}

async function canFetch(url) {
  try {
    const r = await fetch(url);
    return r.ok;
  } catch {
    return false;
  }
}
async function waitForHttp(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await canFetch(url)) return true;
    await wait(250);
  }
  return false;
}
async function waitForJson(port, timeoutMs = 10000) {
  const url = `http://127.0.0.1:${port}/json`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const pages = await fetch(url).then((r) => r.json());
      if (Array.isArray(pages) && pages.length > 0) return pages;
    } catch {}
    await wait(250);
  }
  throw new Error(`DevTools endpoint not ready on ${url}`);
}

function cdpFactory() {
  let nextId = 0;
  const pending = new Map();
  return {
    bind(ws) {
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        } else {
          if (
            ['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded'].includes(
              msg.method,
            )
          ) {
            if (!ws.__events) ws.__events = [];
            ws.__events.push(msg);
          }
        }
      };
    },
    call(ws, method, params = {}) {
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolveP, rejectP) => {
        const t = setTimeout(() => {
          pending.delete(id);
          rejectP(new Error(`CDP timeout for ${method}`));
        }, 15000);
        pending.set(id, (msg) => {
          clearTimeout(t);
          if (msg.error) rejectP(new Error(`${method}: ${msg.error.message}`));
          else resolveP(msg);
        });
      });
    },
  };
}

function analyzePng(path) {
  const png = PNG.sync.read(readFileSync(path));
  let count = 0;
  let sum = 0;
  let sum2 = 0;
  let nonBlack = 0;
  const step = Math.max(1, Math.floor((png.width * png.height) / 20000));
  for (let i = 0, px = 0; i < png.data.length; i += 4, px++) {
    if (px % step !== 0) continue;
    const a = png.data[i + 3] / 255;
    if (a < 0.01) continue;
    const luma = (0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2]) * a;
    sum += luma;
    sum2 += luma * luma;
    if (luma > 8) nonBlack++;
    count++;
  }
  const mean = count > 0 ? sum / count : 0;
  const variance = count > 0 ? sum2 / count - mean * mean : 0;
  return {
    width: png.width,
    height: png.height,
    mean: +mean.toFixed(2),
    variance: +variance.toFixed(2),
    nonBlackRatio: count > 0 ? +(nonBlack / count).toFixed(3) : 0,
  };
}

async function resolveSmokeLabUrl(baseUrl, element, cwd) {
  // Live manifest first.
  try {
    const r = await fetch(`${baseUrl}/__manifest`);
    if (r.ok) {
      const m = await r.json();
      const entry = m?.elements?.[element];
      if (entry?.labUrl) {
        return /^https?:\/\//.test(entry.labUrl)
          ? entry.labUrl
          : `${baseUrl}${entry.labUrl.startsWith('/') ? '' : '/'}${entry.labUrl}`;
      }
    }
  } catch {}
  // Then package.json#triscope.labs.
  try {
    const p = join(cwd, 'package.json');
    if (existsSync(p)) {
      const pkg = JSON.parse(readFileSync(p, 'utf8'));
      const m = pkg?.triscope?.labs;
      if (m && typeof m === 'object' && m[element]) {
        const v = m[element];
        return /^https?:\/\//.test(v) ? v : `${baseUrl}${v.startsWith('/') ? '' : '/'}${v}`;
      }
    }
  } catch {}
  // Convention fallback.
  return `${baseUrl}/labs/${element}.html`;
}

export async function runSmoke({ element, url, screenshot } = {}) {
  const cwd = process.cwd();
  const project = readProjectName(cwd);
  const baseUrl = (url ?? 'http://localhost:5173/').replace(/\/$/, '');
  // URL resolution mirrors @triscope/mcp's resolveLabUrl (kept in sync):
  // 1. explicit --url wins, 2. manifest, 3. package.json#triscope.labs, 4. /labs/<name>.html.
  let targetUrl;
  if (url) {
    targetUrl = url;
  } else if (element) {
    targetUrl = await resolveSmokeLabUrl(baseUrl, element, cwd);
  } else {
    targetUrl = baseUrl;
  }
  const SCREENSHOT = screenshot ?? join(tmpdir(), `${project}-smoke-${element ?? 'default'}.png`);
  const DEBUG_PORT = Number(process.env.TRISCOPE_DEBUG_PORT ?? 9230);
  const CHROME = process.env.CHROME_BIN ?? 'chromium';

  let vite = null;
  let chrome = null;
  let ws = null;
  let exitCode = 0;
  const events = [];
  const cdp = cdpFactory();

  try {
    if (!(await canFetch(baseUrl))) {
      // Spawn vite from the current project
      const localVite = resolve(cwd, 'node_modules/.bin/vite');
      const viteBin = existsSync(localVite) ? localVite : 'vite';
      vite = spawn(viteBin, [], { cwd, stdio: 'inherit' });
      if (!(await waitForHttp(baseUrl, 15000))) {
        throw new Error(`Vite did not respond at ${baseUrl}`);
      }
    }

    chrome = spawn(CHROME, [
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist',
      `--user-data-dir=/tmp/triscope-chrome-profile-${Date.now()}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--window-size=1600,900',
      targetUrl,
    ]);

    const pages = await waitForJson(DEBUG_PORT);
    const page = pages.find((p) => p.url === targetUrl || p.url.startsWith(targetUrl)) ?? pages[0];
    ws = new WebSocket(page.webSocketDebuggerUrl);
    cdp.bind(ws);
    await new Promise((res) => {
      ws.onopen = res;
    });
    await cdp.call(ws, 'Runtime.enable');
    await cdp.call(ws, 'Log.enable');
    await cdp.call(ws, 'Page.enable');
    await wait(6000);

    const stateResult = await cdp.call(ws, 'Runtime.evaluate', {
      expression: `({
        href: location.href,
        boot: document.getElementById('boot')?.textContent || null,
        hud: document.getElementById('hud')?.textContent || null,
        webgpu: !!navigator.gpu,
        canvas: [...document.querySelectorAll('canvas')].map((c) => ({
          w: c.width, h: c.height, clientW: c.clientWidth, clientH: c.clientHeight
        })),
        labels: [...document.querySelectorAll('.triscope-label, .label')].map(el => el.textContent?.trim()),
        triscope: !!window.__TRISCOPE__,
        element: window.__TRISCOPE__?.element?.name || null,
        cameraNames: window.__TRISCOPE__ ? Object.keys(window.__TRISCOPE__.cameras) : []
      })`,
      returnByValue: true,
    });
    const state = stateResult.result.result.value;

    mkdirSync(dirname(SCREENSHOT), { recursive: true });
    const shot = await cdp.call(ws, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    writeFileSync(SCREENSHOT, Buffer.from(shot.result.data, 'base64'));
    const screenshotStats = analyzePng(SCREENSHOT);

    const problems = (ws.__events ?? [])
      .map((e) => ({
        method: e.method,
        level: e.params?.entry?.level,
        url: e.params?.entry?.url,
        text:
          e.params?.args?.map((a) => a.value || a.description).join(' ') ||
          e.params?.entry?.text ||
          e.params?.exceptionDetails?.exception?.description ||
          e.params?.exceptionDetails?.text,
      }))
      .filter((e) => e.method === 'Runtime.exceptionThrown' || e.level === 'error')
      .filter((e) => !String(e.url).includes('favicon.ico'));

    const summary = { url: targetUrl, screenshot: SCREENSHOT, state, screenshotStats, problems };
    console.log(JSON.stringify(summary, null, 2));

    // Asserts
    if (!state.webgpu) throw new Error('navigator.gpu unavailable');
    if (state.boot !== null) throw new Error(`Boot overlay still visible: ${state.boot}`);
    if (!state.canvas?.[0]?.w || !state.canvas?.[0]?.h) {
      throw new Error('Canvas has invalid dimensions');
    }
    if (!state.triscope) throw new Error('window.__TRISCOPE__ not present — harness did not mount');
    if (screenshotStats.nonBlackRatio < 0.2) {
      throw new Error(`Screenshot is mostly black: ${JSON.stringify(screenshotStats)}`);
    }
    if (screenshotStats.variance < 80) {
      throw new Error(`Screenshot is too flat: ${JSON.stringify(screenshotStats)}`);
    }
    if (problems.length > 0) throw new Error(`Runtime errors reported: ${problems.length}`);

    await cdp.call(ws, 'Browser.close').catch(() => {});
  } catch (err) {
    console.error('smoke failed:', err.message);
    exitCode = 1;
  } finally {
    try {
      ws?.close();
    } catch {}
    if (chrome && !chrome.killed) chrome.kill();
    if (vite && !vite.killed) vite.kill();
  }
  process.exit(exitCode);
}
