// Triscope MCP server.
//
// Exposes tools that talk to a running triscope dev server (default
// http://localhost:5173) and the on-disk telemetry sink it writes:
//   - list_elements    : GET /__manifest
//   - read_telemetry   : read /tmp/<project>-state.json, optional jq-style path
//   - set_knob         : POST /__knob (harness polls and applies live)
//   - capture_views    : drives a fresh headed Chromium via CDP, calls
//                        window.__TRISCOPE__.captureViews(), writes per-camera
//                        PNGs to /tmp/<project>-capture-<element>/<camera>.png
//   - run_smoke        : spawns `triscope smoke <element>` and returns pass/fail
//
// Configuration env vars:
//   TRISCOPE_URL          (default http://localhost:5173)
//   TRISCOPE_PROJECT      (default: derived from process.cwd()/package.json#name)
//   TRISCOPE_DEBUG_PORT   (default 9230)
//   CHROME_BIN            (default 'chromium')

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function readProjectName(cwd) {
  if (process.env.TRISCOPE_PROJECT) return process.env.TRISCOPE_PROJECT;
  try {
    const p = join(cwd, 'package.json');
    if (!existsSync(p)) return 'triscope-project';
    const pkg = JSON.parse(readFileSync(p, 'utf8'));
    return String(pkg.name ?? 'triscope-project').replace(/[^A-Za-z0-9._-]/g, '-');
  } catch {
    return 'triscope-project';
  }
}

const DEV_URL = (process.env.TRISCOPE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const PROJECT = readProjectName(process.cwd());
const STATE_PATH = join(tmpdir(), `${PROJECT}-state.json`);

function applyPath(data, path) {
  if (!path) return data;
  const segs = path.replace(/^\./, '').split('.').filter(Boolean);
  let cur = data;
  for (const s of segs) {
    if (cur == null) return undefined;
    cur = cur[s];
  }
  return cur;
}

async function fetchManifest() {
  try {
    const r = await fetch(`${DEV_URL}/__manifest`);
    if (!r.ok) return null;
    const m = await r.json();
    // Shape: { elements: { [name]: { element, labUrl, cameras, knobs } } }
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

function readProjectLabMap(cwd) {
  try {
    const p = join(cwd, 'package.json');
    if (!existsSync(p)) return {};
    const pkg = JSON.parse(readFileSync(p, 'utf8'));
    const m = pkg?.triscope?.labs;
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}

const PROJECT_LABS = readProjectLabMap(process.cwd());

function absolutize(maybePath) {
  if (!maybePath) return null;
  if (/^https?:\/\//.test(maybePath)) return maybePath;
  return `${DEV_URL}${maybePath.startsWith('/') ? '' : '/'}${maybePath}`;
}

async function resolveLabUrl({ element, labUrl }) {
  // 1. Explicit arg wins.
  if (labUrl) return absolutize(labUrl);
  if (!element) return DEV_URL;
  // 2. Live manifest from a running lab.
  const manifest = await fetchManifest();
  const entry = manifest?.elements?.[element];
  if (entry?.labUrl) return absolutize(entry.labUrl);
  // 3. Per-project escape hatch in package.json#triscope.labs.
  if (PROJECT_LABS[element]) return absolutize(PROJECT_LABS[element]);
  // 4. Convention fallback.
  return `${DEV_URL}/labs/${element}.html`;
}

async function listElements() {
  const m = await fetchManifest();
  if (!m || !m.elements || Object.keys(m.elements).length === 0) {
    return { manifest: null, note: 'Dev server is up but no manifest has been posted yet. Load a lab page first.' };
  }
  return { manifest: m };
}

async function readTelemetry(path) {
  if (!existsSync(STATE_PATH)) {
    throw new Error(`No telemetry at ${STATE_PATH}. Is the dev server running and a lab page open?`);
  }
  const data = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  return applyPath(data, path);
}

async function setKnob(element, key, value) {
  const r = await fetch(`${DEV_URL}/__knob`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ element, key, value }),
  });
  if (!r.ok) throw new Error(`__knob returned ${r.status}`);
  return { ok: true, element, key, value };
}

async function captureViews({ element, labUrl, inline = true }) {
  // Drive a fresh Chromium against the lab URL, evaluate
  // window.__TRISCOPE__.captureViews(), write PNGs per camera.
  const target = await resolveLabUrl({ element, labUrl });
  const port = Number(process.env.TRISCOPE_DEBUG_PORT ?? 9230);
  const chromeBin = process.env.CHROME_BIN ?? 'chromium';
  const outDir = join(tmpdir(), `${PROJECT}-capture-${element ?? 'scene'}`);
  mkdirSync(outDir, { recursive: true });

  const chrome = spawn(chromeBin, [
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    `--user-data-dir=/tmp/triscope-mcp-profile-${Date.now()}`,
    `--remote-debugging-port=${port}`,
    '--window-size=1600,900',
    target,
  ]);

  try {
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
    const page = pages.find((p) => p.url === target || p.url?.startsWith(target)) ?? pages[0];

    const ws = new WebSocket(page.webSocketDebuggerUrl);
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

    await new Promise((res) => {
      ws.onopen = res;
    });
    await call('Runtime.enable');
    await call('Page.enable');
    // Wait for the harness to mount.
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const probe = await call('Runtime.evaluate', {
        expression: '!!window.__TRISCOPE__ && Object.keys(window.__TRISCOPE__.cameras).length',
        returnByValue: true,
      });
      if (probe.result.result.value) { ready = true; break; }
      await wait(250);
    }
    if (!ready) throw new Error('window.__TRISCOPE__ did not become available within 10s');

    const result = await call('Runtime.evaluate', {
      expression: 'window.__TRISCOPE__.captureViews()',
      awaitPromise: true,
      returnByValue: true,
    });
    const views = result.result.result.value;
    if (!views || typeof views !== 'object') {
      throw new Error('captureViews returned an empty result');
    }
    const written = {};
    const base64ByCam = {};
    for (const [cam, dataUrl] of Object.entries(views)) {
      if (typeof dataUrl !== 'string') continue;
      const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      const path = join(outDir, `${cam}.png`);
      writeFileSync(path, Buffer.from(b64, 'base64'));
      written[cam] = path;
      base64ByCam[cam] = b64;
    }
    const telemetry = await call('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__TRISCOPE__.sampleTelemetry())',
      returnByValue: true,
    });
    const sample = JSON.parse(telemetry.result.result.value);

    try { ws.close(); } catch {}
    return {
      element: element ?? null,
      dir: outDir,
      files: written,
      cameraOrder: Object.keys(written),
      telemetry: sample,
      inline,
      _base64ByCam: base64ByCam,
    };
  } finally {
    if (!chrome.killed) chrome.kill();
  }
}

async function runSmoke({ element }) {
  return new Promise((resolve, reject) => {
    const args = ['smoke'];
    if (element) args.push(element);
    const child = spawn('triscope', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ exitCode: code ?? 0, stdout: out, stderr: err }));
  });
}

const tools = [
  {
    name: 'list_elements',
    description:
      'List elements registered with the running triscope dev server, including each element\'s named cameras and current knob values. Returns the live manifest the harness posted on boot.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_telemetry',
    description:
      'Read the latest telemetry snapshot from /tmp/<project>-state.json. Optional jq-style "path" (e.g. ".elements.ship.triangles" or ".perf.fps") returns just that slice. Use this for hidden numeric state (FPS, uniform values, lum stats) where screenshots lie.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Dot-separated jq-style path into the snapshot.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'set_knob',
    description:
      'Live-update a single knob on a registered element. Use absolute values (e.g. set_knob("ship","mastTilt",0.1), not "increase by 0.1"). The change takes effect in the running browser within ~100 ms.',
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string', description: 'Element name (from list_elements).' },
        key: { type: 'string', description: 'Knob key (e.g. "mastTilt").' },
        value: { description: 'New absolute value. Number, string ("#aabbcc" for color), or boolean.' },
      },
      required: ['element', 'key', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'capture_views',
    description:
      'Spawn Chromium against a lab page (resolved via Element.labUrl in the manifest, package.json#triscope.labs, or /labs/<element>.html as fallback) and render every named camera. Writes PNGs to /tmp/<project>-capture-<element>/<camera>.png AND returns each image inline as MCP image content blocks (so the model sees them directly without a Read call). Set inline=false to return paths only (smaller payload).',
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string', description: 'Element name. URL is resolved via manifest/config.' },
        labUrl: { type: 'string', description: 'Override the lab URL entirely (highest precedence).' },
        inline: { type: 'boolean', description: 'Return images as inline content blocks. Default true.', default: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'run_smoke',
    description:
      'Run the headed-Chromium smoke harness against a lab page. Returns exit code, stdout, stderr. Use as a CI gate after a batch of knob changes.',
    inputSchema: {
      type: 'object',
      properties: { element: { type: 'string', description: 'Element lab to test (defaults to the scene lab).' } },
      additionalProperties: false,
    },
  },
];

function jsonResult(value) {
  return {
    content: [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

export async function startServer() {
  const server = new Server(
    { name: 'triscope-mcp', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      switch (name) {
        case 'list_elements':
          return jsonResult(await listElements());
        case 'read_telemetry':
          return jsonResult(await readTelemetry(args.path));
        case 'set_knob': {
          const parsed = z
            .object({
              element: z.string(),
              key: z.string(),
              value: z.union([z.number(), z.string(), z.boolean()]),
            })
            .parse(args);
          return jsonResult(await setKnob(parsed.element, parsed.key, parsed.value));
        }
        case 'capture_views': {
          const res = await captureViews({
            element: args.element,
            labUrl: args.labUrl,
            inline: args.inline ?? true,
          });
          const { _base64ByCam, ...summary } = res;
          const text = JSON.stringify(summary, null, 2);
          if (!res.inline) return { content: [{ type: 'text', text }] };
          const content = [{ type: 'text', text }];
          for (const cam of res.cameraOrder) {
            const data = _base64ByCam[cam];
            if (!data) continue;
            content.push({ type: 'image', data, mimeType: 'image/png' });
          }
          return { content };
        }
        case 'run_smoke':
          return jsonResult(await runSmoke({ element: args.element }));
        default:
          return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
      }
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `${name} failed: ${err?.message ?? String(err)}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error(`[triscope-mcp] connected. dev server: ${DEV_URL}, project: ${PROJECT}`);
}
