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

import { setReference, diffReference, refsPath, composeFilmstrip, motionMagnitudeFromFrames } from './refs.mjs';
import { createBrowserPool } from './browser.mjs';

const browserPool = createBrowserPool();
const shutdown = () => browserPool.dispose();
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(130); });
process.on('SIGTERM', () => { shutdown(); process.exit(143); });

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

async function setKnob(payload) {
  // `payload` is either a single {element,key,value} or {updates:[...]}.
  // The /__knob endpoint accepts arrays natively (telemetry.ts line 94).
  const body = Array.isArray(payload?.updates)
    ? JSON.stringify(payload.updates)
    : JSON.stringify(payload);
  const r = await fetch(`${DEV_URL}/__knob`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  if (!r.ok) throw new Error(`__knob returned ${r.status}`);
  return { ok: true, count: Array.isArray(payload?.updates) ? payload.updates.length : 1 };
}

async function captureViews({ element, labUrl, inline = true }) {
  // Persistent Chromium: first call cold-starts (~3s), subsequent calls
  // reuse the same browser/page and just navigate if the URL changed.
  const target = await resolveLabUrl({ element, labUrl });
  const outDir = join(tmpdir(), `${PROJECT}-capture-${element ?? 'scene'}`);
  mkdirSync(outDir, { recursive: true });

  const t0 = Date.now();
  const { call } = await browserPool.getPage(target);
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

  return {
    element: element ?? null,
    dir: outDir,
    files: written,
    cameraOrder: Object.keys(written),
    telemetry: sample,
    inline,
    captureMs: Date.now() - t0,
    _base64ByCam: base64ByCam,
  };
}

async function captureMotion({ element, camera, frames = 6, dt = 0.25, mode = 'time', labUrl }) {
  // Multi-frame capture per camera through the persistent browser pool.
  // Returns per-camera filmstrip base64 + motionMagnitude scalar + telemetry.
  const target = await resolveLabUrl({ element, labUrl });
  const outDir = join(tmpdir(), `${PROJECT}-motion-${element ?? 'scene'}`);
  mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const { call } = await browserPool.getPage(target);

  // Pick the camera set: explicit single name or all cameras for the element.
  let cameraOrder;
  if (camera) {
    cameraOrder = [camera];
  } else {
    const camsProbe = await call('Runtime.evaluate', {
      expression: 'Object.keys(window.__TRISCOPE__.cameras)',
      returnByValue: true,
    });
    cameraOrder = camsProbe.result.result.value ?? [];
  }
  if (!Array.isArray(cameraOrder) || cameraOrder.length === 0) {
    throw new Error('no cameras available — is the harness mounted?');
  }

  const filmstripPaths = {};
  const filmstripBase64 = {};
  const magnitudeByCam = {};
  for (const camName of cameraOrder) {
    const result = await call('Runtime.evaluate', {
      expression: `window.__TRISCOPE__.captureMotionFrames(${JSON.stringify(camName)}, ${JSON.stringify({ frames, dt, mode })})`,
      awaitPromise: true,
      returnByValue: true,
    });
    const dataUrls = result.result.result.value;
    if (!Array.isArray(dataUrls) || dataUrls.length === 0) {
      throw new Error(`captureMotionFrames returned empty for camera "${camName}"`);
    }
    const strip = composeFilmstrip(dataUrls);
    const stripPath = join(outDir, `${camName}.filmstrip.png`);
    writeFileSync(stripPath, strip);
    filmstripPaths[camName] = stripPath;
    filmstripBase64[camName] = strip.toString('base64');
    magnitudeByCam[camName] = motionMagnitudeFromFrames(dataUrls);
  }

  const telemetry = await call('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__TRISCOPE__.sampleTelemetry())',
    returnByValue: true,
  });
  const sample = JSON.parse(telemetry.result.result.value);

  return {
    element: element ?? null,
    frames,
    dt,
    mode,
    dir: outDir,
    filmstrips: filmstripPaths,
    cameraOrder,
    motionMagnitude: magnitudeByCam,
    captureMs: Date.now() - t0,
    telemetry: sample,
    _filmstripBase64: filmstripBase64,
  };
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
      'Live-update one or many knobs in a single round trip. Either pass {element,key,value} for a single update OR {updates:[{element,key,value},...]} to batch. Use absolute values, never deltas. Changes take effect in the running browser within ~100 ms.',
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string', description: 'Element name (single-update form).' },
        key: { type: 'string', description: 'Knob key (single-update form).' },
        value: { description: 'Absolute value (number, "#aabbcc" color, boolean).' },
        updates: {
          type: 'array',
          description: 'Batch form: array of {element,key,value} entries applied atomically.',
          items: {
            type: 'object',
            properties: {
              element: { type: 'string' },
              key: { type: 'string' },
              value: {},
            },
            required: ['element', 'key', 'value'],
          },
        },
      },
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
    name: 'set_reference',
    description:
      'Save a reference image for an (element, camera) pair under <project>/refs/<element>/<camera>.png. Accepts EITHER a `path` to a file on disk (e.g. a chat-attachment path) OR `base64` inline PNG data. Use this when the user pastes a reference image they want the AI to converge toward.',
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string', description: 'Element name.' },
        camera: { type: 'string', description: 'Camera name (must match Element.cameras key).' },
        path: { type: 'string', description: 'Filesystem path to a PNG/JPEG (one of path or base64 required).' },
        base64: { type: 'string', description: 'Base64-encoded PNG (with or without data: prefix).' },
      },
      required: ['element', 'camera'],
      additionalProperties: false,
    },
  },
  {
    name: 'diff_reference',
    description:
      'Capture the current view at (element, camera), compose it side-by-side with the stored reference (left=ref, right=current), and return BOTH a numeric meanAbsDiff (0-255, 0=identical) AND the composite as an inline image content block. Requires a prior set_reference for the same (element, camera).',
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string', description: 'Element name.' },
        camera: { type: 'string', description: 'Camera name.' },
        labUrl: { type: 'string', description: 'Override the lab URL (otherwise resolved like capture_views).' },
      },
      required: ['element', 'camera'],
      additionalProperties: false,
    },
  },
  {
    name: 'capture_motion',
    description:
      'Capture N frames per camera spaced by dt seconds, compose each into an inline filmstrip image (frames tiled left-to-right), and return a numeric motionMagnitude per camera (0-255 scale; <1 = static, >5 = visible motion, >20 = vigorous). Use this WHEN THE ELEMENT HAS ANIMATION (shader-driven motion, sail billow, particle systems, oscillation) — a single capture_views frame cannot reveal whether motion is happening. For complementary numeric verification of hidden animated state, read_telemetry .elements.<name>.motion (if the Element declared motionProbes).',
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string' },
        camera: { type: 'string', description: 'Single camera. Omit to capture all cameras (one filmstrip each).' },
        frames: { type: 'number', description: 'Frames per filmstrip. Default 6.' },
        dt: { type: 'number', description: 'Seconds between captured frames. Default 0.25.' },
        mode: { type: 'string', enum: ['time', 'real'], description: '"time" (default) is deterministic (steps time.value, fast). "real" runs wall-clock (slower; needed for CPU-integrated state).' },
        labUrl: { type: 'string', description: 'Override the lab URL (otherwise resolved like capture_views).' },
        inline: { type: 'boolean', description: 'Include filmstrips as inline images. Default true.' },
      },
      required: ['element'],
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
          const value = z.union([z.number(), z.string(), z.boolean()]);
          const update = z.object({ element: z.string(), key: z.string(), value });
          const schema = z.union([
            z.object({ updates: z.array(update).min(1) }),
            update,
          ]);
          const parsed = schema.parse(args);
          return jsonResult(await setKnob(parsed));
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
        case 'set_reference': {
          const parsed = z
            .object({
              element: z.string(),
              camera: z.string(),
              path: z.string().optional(),
              base64: z.string().optional(),
            })
            .parse(args);
          const result = setReference({ cwd: process.cwd(), ...parsed });
          return jsonResult(result);
        }
        case 'diff_reference': {
          const parsed = z
            .object({
              element: z.string(),
              camera: z.string(),
              labUrl: z.string().optional(),
            })
            .parse(args);
          const refExists = existsSync(refsPath(process.cwd(), parsed.element, parsed.camera));
          if (!refExists) {
            return {
              isError: true,
              content: [{
                type: 'text',
                text: `no reference at ${refsPath(process.cwd(), parsed.element, parsed.camera)}. Call set_reference first.`,
              }],
            };
          }
          const cap = await captureViews({ element: parsed.element, labUrl: parsed.labUrl, inline: true });
          const currentBase64 = cap._base64ByCam?.[parsed.camera];
          if (!currentBase64) {
            return {
              isError: true,
              content: [{
                type: 'text',
                text: `camera "${parsed.camera}" not found on element "${parsed.element}". Available: ${cap.cameraOrder.join(', ')}`,
              }],
            };
          }
          const diff = diffReference({
            cwd: process.cwd(),
            element: parsed.element,
            camera: parsed.camera,
            currentBase64,
          });
          return {
            content: [
              { type: 'text', text: JSON.stringify({
                camera: diff.camera,
                refPath: diff.refPath,
                meanAbsDiff: diff.meanAbsDiff,
                hint: '0 = identical, ~30 = visibly close, >80 = clearly different',
              }, null, 2) },
              { type: 'image', data: diff.compositeBase64, mimeType: 'image/png' },
            ],
          };
        }
        case 'capture_motion': {
          const parsed = z
            .object({
              element: z.string(),
              camera: z.string().optional(),
              frames: z.number().int().min(2).max(32).optional(),
              dt: z.number().positive().max(5).optional(),
              mode: z.enum(['time', 'real']).optional(),
              labUrl: z.string().optional(),
              inline: z.boolean().optional(),
            })
            .parse(args);
          const res = await captureMotion(parsed);
          const { _filmstripBase64, ...summary } = res;
          const text = JSON.stringify({
            ...summary,
            hint: '<1 = static, >5 = visible motion, >20 = vigorous (in motionMagnitude)',
          }, null, 2);
          if (parsed.inline === false) return { content: [{ type: 'text', text }] };
          const content = [{ type: 'text', text }];
          for (const cam of res.cameraOrder) {
            const data = _filmstripBase64[cam];
            if (data) content.push({ type: 'image', data, mimeType: 'image/png' });
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
