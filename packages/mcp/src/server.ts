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
import { PNG } from 'pngjs';

import {
  setReference, diffReference, refsPath,
  composeFilmstrip, motionMagnitudeFromFrames,
  setReferenceMotion, diffReferenceMotion, refsMotionPaths,
} from './refs.js';
import { createBrowserPool } from './browser.js';
import { createLogger } from './logger.js';

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
// Inline image payload safety cap. MCP stdio JSON-RPC has practical message
// size limits and ours exceeded them at 12 cameras × 1280×720 PNG base64 →
// the server process got OOM-killed mid-response. Override with
// TRISCOPE_INLINE_PAYLOAD_BUDGET (bytes) if you really need bigger.
const INLINE_PAYLOAD_BUDGET = Number(process.env.TRISCOPE_INLINE_PAYLOAD_BUDGET ?? 1024 * 1024);

// ---- Resilience: ring buffer of recent errors + process-level handlers --
// A single rogue async exception used to crash the entire MCP server (the
// process died, Claude Code didn't auto-restart it, and subsequent calls
// timed out with cryptic "Connection closed"). Now we log and continue so
// individual tool failures stay isolated from the server lifecycle.
const SERVER_START_TIME = Date.now();
const RECENT_ERRORS_CAP = 16;
const recentErrors: string[] = [];
const logger = createLogger(PROJECT);
function recordError(source: string, err: unknown) {
  const detail = (err as any)?.stack ?? (err as any)?.message ?? String(err);
  const msg = `[${new Date().toISOString()}] ${source}: ${detail}`;
  logger.error(source, String((err as any)?.message ?? err), { stack: (err as any)?.stack });
  recentErrors.push(msg);
  if (recentErrors.length > RECENT_ERRORS_CAP) recentErrors.shift();
}
process.on('uncaughtException', (err) => recordError('uncaughtException', err));
process.on('unhandledRejection', (err) => recordError('unhandledRejection', err));

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

async function fetchManifest(): Promise<any> {
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

async function resolveLabUrl({ element, labUrl }: { element?: string; labUrl?: string }): Promise<string> {
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

async function captureViews({ element, labUrl, inline = true }: { element?: string; labUrl?: string; inline?: boolean }) {
  // Persistent Chromium: first call cold-starts (~3s), subsequent calls
  // reuse the same browser/page and just navigate if the URL changed.
  const target = await resolveLabUrl({ element, labUrl });
  const outDir = join(tmpdir(), `${PROJECT}-capture-${element ?? 'scene'}`);
  mkdirSync(outDir, { recursive: true });

  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const tNavStart = Date.now();
  const { call } = await browserPool.getPage(target);
  timings.navigate = Date.now() - tNavStart;
  const tRenderStart = Date.now();
  const result = await call('Runtime.evaluate', {
    expression: 'window.__TRISCOPE__.captureViews()',
    awaitPromise: true,
    returnByValue: true,
  });
  timings.render = Date.now() - tRenderStart;
  const views = result.result.result.value;
  if (!views || typeof views !== 'object') {
    // By the time we get here browserPool.getPage has already proven the
    // harness mounted, so an empty result means the Element declared zero
    // cameras OR captureViews itself errored without returning.
    throw new Error(
      `captureViews returned no images for element="${element ?? '(scene)'}" at ${target}. ` +
      `Most likely the Element declares no cameras — check the manifest: ` +
      `mcp__triscope__list_elements.`
    );
  }
  const written = {};
  const base64ByCam = {};
  const tWriteStart = Date.now();
  for (const [cam, dataUrl] of Object.entries(views)) {
    if (typeof dataUrl !== 'string') continue;
    const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const path = join(outDir, `${cam}.png`);
    writeFileSync(path, Buffer.from(b64, 'base64'));
    written[cam] = path;
    base64ByCam[cam] = b64;
  }
  timings.writePngs = Date.now() - tWriteStart;
  const tTelStart = Date.now();
  const telemetry = await call('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__TRISCOPE__.sampleTelemetry())',
    returnByValue: true,
  });
  const sample = JSON.parse(telemetry.result.result.value);
  timings.telemetry = Date.now() - tTelStart;

  // captureViews() populates window.__TRISCOPE__.lastGpuProbes as a side
  // effect (per-camera luminance/p5/p95/dynamicRange). Surface it in the
  // tool response so consumers don't have to do a second CDP eval.
  // If the harness didn't populate it (lab page that doesn't use
  // @triscope/core runLab — e.g. water3d's scene lab which has a custom
  // capture path), we decode the captured PNGs server-side with pngjs
  // and compute the same scalars. Slower (~5 ms per camera) but means
  // GPU probes are available for any captured PNG.
  const tProbeStart = Date.now();
  let gpuProbes: Record<string, any> | null = null;
  let gpuProbesSource: 'harness' | 'server-fallback' | 'unavailable' = 'unavailable';
  try {
    const probesResp = await call('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__TRISCOPE__.lastGpuProbes ?? null)',
      returnByValue: true,
    });
    const fromHarness = JSON.parse(probesResp.result.result.value);
    if (fromHarness && Object.keys(fromHarness).length > 0) {
      gpuProbes = fromHarness;
      gpuProbesSource = 'harness';
    }
  } catch { /* old core — fall through to server-side */ }
  if (!gpuProbes) {
    gpuProbes = {};
    for (const [cam, b64] of Object.entries(base64ByCam) as [string, string][]) {
      try { gpuProbes[cam] = probeStatsFromPng(Buffer.from(b64, 'base64')); }
      catch { /* skip cameras whose PNGs fail to decode */ }
    }
    if (Object.keys(gpuProbes).length === 0) gpuProbes = null;
    else gpuProbesSource = 'server-fallback';
  }
  timings.probes = Date.now() - tProbeStart;

  return {
    element: element ?? null,
    dir: outDir,
    files: written,
    cameraOrder: Object.keys(written),
    telemetry: sample,
    gpuProbes,
    gpuProbesSource,
    inline,
    captureMs: Date.now() - t0,
    timings,
    _base64ByCam: base64ByCam,
  };
}

/** Server-side fallback: same math the harness does, but starting from a
 *  decoded PNG buffer instead of a 2D canvas. Stride-samples to ~2300 px
 *  so the cost is bounded (~5 ms per 1280×720 PNG). */
function probeStatsFromPng(pngBuf: Buffer): {
  luminance: number; p5: number; p95: number; dynamicRange: number; samples: number;
} {
  const img = PNG.sync.read(pngBuf);
  const stride = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 2304)));
  const lums: number[] = [];
  let sum = 0;
  for (let y = 0; y < img.height; y += stride) {
    for (let x = 0; x < img.width; x += stride) {
      const i = (y * img.width + x) * 4;
      const r = img.data[i] / 255;
      const g = img.data[i + 1] / 255;
      const b = img.data[i + 2] / 255;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lums.push(lum);
      sum += lum;
    }
  }
  lums.sort((a, b) => a - b);
  const n = lums.length;
  const p5 = lums[Math.floor(n * 0.05)];
  const p95 = lums[Math.floor(n * 0.95)];
  return {
    luminance: +(sum / n).toFixed(4),
    p5: +p5.toFixed(4),
    p95: +p95.toFixed(4),
    dynamicRange: +(p95 / Math.max(p5, 1 / 255)).toFixed(2),
    samples: n,
  };
}

async function captureMotionFramesRaw({ element, camera, frames, dt, mode, labUrl }: any): Promise<string[]> {
  // Like captureMotion but for ONE camera, returns the raw base64 PNG frames.
  // Used internally by set_reference_motion + diff_reference_motion.
  const target = await resolveLabUrl({ element, labUrl });
  const { call } = await browserPool.getPage(target);
  const result = await call('Runtime.evaluate', {
    expression: `window.__TRISCOPE__.captureMotionFrames(${JSON.stringify(camera)}, ${JSON.stringify({ frames, dt, mode })})`,
    awaitPromise: true,
    returnByValue: true,
  });
  const frames_ = result.result.result.value;
  if (!Array.isArray(frames_) || frames_.length === 0) {
    throw new Error(`captureMotionFrames returned empty for camera "${camera}"`);
  }
  return frames_.map((du) => du.replace(/^data:image\/png;base64,/, ''));
}

async function captureMotion({ element, camera, frames = 6, dt = 0.25, mode = 'time', labUrl }: any) {
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

/**
 * auto_tune (1D): golden-section search over one knob, minimising
 * (1 - SSIM) between the captured target_camera view and the stored
 * reference for that (element, camera). Each iteration: set_knob → wait
 * for the harness to apply (knobPollMs + telemetry tick + margin) →
 * captureViews → diff_reference. Returns the best knob value found,
 * the final SSIM, the iteration history, and total ms.
 *
 * Why golden-section: derivative-free, deterministic, converges
 * exponentially (range × 1/φ per iter ≈ 0.618). 12 iterations narrow a
 * range to ~0.7% — plenty for shader tuning. Robust to noise because we
 * use SSIM (perceptual) rather than meanAbsDiff (pixel-level).
 */
/**
 * Snapshot / restore via git tags.
 *
 * A snapshot freezes a moment in the iteration loop: the git commit you
 * were on + the knob values applied at that moment. Restoring checks out
 * that commit and re-posts the knobs, so a careful tuning state can be
 * recovered after a risky shader rewrite. Tags live under
 * `triscope/snapshot/<name>` so they don't pollute the user's namespace.
 *
 * Guard rails:
 *   - snapshot refuses on a dirty working tree — the commit you'd point
 *     at wouldn't actually contain your in-progress edits, so the
 *     restore would silently revert them.
 *   - restore refuses on a dirty WT too, for the same reason in reverse.
 *   - PNG refs are intentionally not bundled into the snapshot for the
 *     MVP — they live next to the project as before (refs/<el>/<cam>.png)
 *     and are recovered with the git checkout. Keeping the JSON small.
 */
const SNAPSHOT_TAG_PREFIX = 'triscope/snapshot/';

// Windows portability: npm/git/code are .cmd scripts on Win32. child_process
// .spawn refuses to invoke them without `shell: true`. On Linux/macOS the
// real binaries are on PATH and shell isn't needed. We set the flag
// conditionally everywhere we spawn one of those tools.
const NEED_SHELL = process.platform === 'win32';

function git(args: string[], cwd: string = process.cwd()): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: NEED_SHELL });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

async function assertCleanWt(cwd: string, action: string): Promise<void> {
  const status = await git(['status', '--porcelain'], cwd);
  if (status.stdout.length > 0) {
    throw new Error(
      `${action} refuses to run with a dirty working tree. Commit, stash, or revert your in-progress edits first.\nDirty paths:\n${status.stdout.split('\n').slice(0, 10).join('\n')}`
    );
  }
}

async function fetchPersistedKnobs(): Promise<Record<string, Record<string, unknown>>> {
  try {
    const r = await fetch(`${DEV_URL}/__knob/current`);
    if (!r.ok) return {};
    return (await r.json()) as Record<string, Record<string, unknown>>;
  } catch { return {}; }
}

async function snapshot({ name, message }: { name: string; message?: string }) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`snapshot name must be [A-Za-z0-9._-]+ (got "${name}")`);
  }
  const cwd = process.cwd();
  await assertCleanWt(cwd, 'snapshot');
  const head = await git(['rev-parse', 'HEAD'], cwd);
  if (head.code !== 0) throw new Error(`git rev-parse failed: ${head.stderr}`);
  const knobs = await fetchPersistedKnobs();
  const payload = {
    name,
    createdAt: new Date().toISOString(),
    commit: head.stdout,
    message: message ?? '',
    knobs, // { [element]: { [knobKey]: value, ... } }
  };
  const tagName = `${SNAPSHOT_TAG_PREFIX}${name}`;
  // Annotated tag stores the JSON payload as the tag message — no extra
  // working-tree files, no rebase noise, easy to list+read with `git tag`.
  const tagBody = `triscope snapshot v1\n\n${JSON.stringify(payload, null, 2)}`;
  const tag = await git(['tag', '-a', tagName, '-m', tagBody, payload.commit], cwd);
  if (tag.code !== 0) {
    if (tag.stderr.includes('already exists')) {
      throw new Error(`snapshot "${name}" already exists. Pick a different name or delete the existing tag: git tag -d ${tagName}`);
    }
    throw new Error(`git tag failed: ${tag.stderr}`);
  }
  return { ok: true, tag: tagName, ...payload, hint: 'Restore later with mcp__triscope__restore name=' + name };
}

async function listSnapshots() {
  const cwd = process.cwd();
  const list = await git(['tag', '--list', `${SNAPSHOT_TAG_PREFIX}*`, '--format=%(refname:short)|%(creatordate:iso)|%(subject)'], cwd);
  if (list.code !== 0) throw new Error(`git tag --list failed: ${list.stderr}`);
  const snapshots: Array<{ name: string; tag: string; created: string; subject: string }> = [];
  for (const line of list.stdout.split('\n').filter(Boolean)) {
    const [tag, created, ...subj] = line.split('|');
    snapshots.push({
      name: tag.replace(SNAPSHOT_TAG_PREFIX, ''),
      tag,
      created,
      subject: subj.join('|'),
    });
  }
  return { count: snapshots.length, snapshots };
}

async function restore({ name }: { name: string }) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid snapshot name`);
  const cwd = process.cwd();
  await assertCleanWt(cwd, 'restore');
  const tagName = `${SNAPSHOT_TAG_PREFIX}${name}`;
  const show = await git(['cat-file', '-p', tagName], cwd);
  if (show.code !== 0) throw new Error(`snapshot "${name}" not found (tag ${tagName})`);
  // Annotated tag object body: header lines, blank line, then the message
  // we wrote in snapshot(). Find the JSON block.
  const bodyMatch = show.stdout.match(/\n\n([\s\S]*)/);
  const body = bodyMatch?.[1] ?? '';
  const jsonStart = body.indexOf('{');
  if (jsonStart < 0) throw new Error(`snapshot ${name} has no JSON payload`);
  let payload: any;
  try { payload = JSON.parse(body.slice(jsonStart)); }
  catch { throw new Error(`snapshot ${name} payload is not valid JSON`); }
  // Checkout the commit the snapshot pointed at (detached HEAD — safe,
  // user can create a branch from there if they want to keep working).
  const checkout = await git(['checkout', payload.commit], cwd);
  if (checkout.code !== 0) throw new Error(`git checkout ${payload.commit} failed: ${checkout.stderr}`);
  // Re-post knobs. The harness will pick them up via its 100ms poll once
  // it next mounts (or immediately if already mounted on the same commit).
  const updates: Array<{ element: string; key: string; value: unknown }> = [];
  for (const [elName, kv] of Object.entries(payload.knobs ?? {})) {
    for (const [k, v] of Object.entries(kv as Record<string, unknown>)) {
      updates.push({ element: elName, key: k, value: v });
    }
  }
  if (updates.length > 0) {
    try { await setKnob({ updates }); } catch { /* dev server may be down — knobs will re-hydrate on next runLab */ }
  }
  return { ok: true, tag: tagName, restoredCommit: payload.commit, knobUpdates: updates.length, payload };
}

async function autoTune({
  element, knob, range, target_camera, max_iterations = 12, labUrl,
}: {
  element: string;
  knob: string;
  range: [number, number];
  target_camera: string;
  max_iterations?: number;
  labUrl?: string;
}) {
  const refPath = refsPath(process.cwd(), element, target_camera);
  if (!existsSync(refPath)) {
    throw new Error(
      `auto_tune needs a reference image at ${refPath}. Call set_reference ` +
      `with element=${element}, camera=${target_camera} first (or paste a PNG path/base64).`
    );
  }
  const target = await resolveLabUrl({ element, labUrl });
  const { call } = await browserPool.getPage(target);

  const phi = (1 + Math.sqrt(5)) / 2;
  const invPhi = 1 / phi;
  let [a, b] = range;
  if (!(b > a)) throw new Error(`auto_tune range must be [min, max] with max > min, got [${a}, ${b}]`);

  const cache = new Map<string, number>(); // memoize SSIM by knob value
  const history: Array<{ iter: number; knob: number; ssim: number; ms: number }> = [];
  const t0 = Date.now();

  async function evalAt(x: number): Promise<number> {
    const key = x.toFixed(6);
    if (cache.has(key)) return cache.get(key)!;
    const iterStart = Date.now();
    // 1. Post knob via the harness's /__knob endpoint.
    await setKnob({ element, key: knob, value: x });
    // 2. Wait for harness apply (knob poll 100ms + telemetry tick 500ms + margin).
    await new Promise((r) => setTimeout(r, 800));
    // 3. Capture target camera in-tab.
    const cap = await call('Runtime.evaluate', {
      expression: 'window.__TRISCOPE__.captureViews()',
      awaitPromise: true,
      returnByValue: true,
    });
    const views = cap.result.result.value ?? {};
    const b64 = String(views[target_camera] ?? '').replace(/^data:image\/png;base64,/, '');
    if (!b64) throw new Error(`auto_tune: captureViews returned no PNG for camera "${target_camera}"`);
    // 4. Diff against reference; we minimise (1 - SSIM).
    const diff = diffReference({ cwd: process.cwd(), element, camera: target_camera, currentBase64: b64 });
    const score = diff.ssim;
    cache.set(key, score);
    history.push({ iter: history.length, knob: x, ssim: score, ms: Date.now() - iterStart });
    return score;
  }

  // Initial bracket.
  let c = b - (b - a) * invPhi;
  let d = a + (b - a) * invPhi;
  let fc = await evalAt(c);
  let fd = await evalAt(d);

  for (let i = 0; i < max_iterations - 2; i++) {
    // Maximise SSIM ⇔ minimise (1 - SSIM): keep the side with higher SSIM.
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - (b - a) * invPhi;
      fc = await evalAt(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + (b - a) * invPhi;
      fd = await evalAt(d);
    }
    // Early stop when the bracket is below 1% of the original range.
    if (Math.abs(b - a) < (range[1] - range[0]) * 0.01) break;
  }

  const best = [...cache.entries()]
    .map(([k, v]) => ({ knob: Number(k), ssim: v }))
    .sort((x, y) => y.ssim - x.ssim)[0];

  // Leave the knob at the best value so the user sees the converged state.
  await setKnob({ element, key: knob, value: best.knob });

  return {
    element,
    knob,
    target_camera,
    bestKnobValue: best.knob,
    bestSsim: best.ssim,
    iterations: history.length,
    history,
    totalMs: Date.now() - t0,
    hint: 'SSIM 1.0 = identical to reference, 0.9+ = visually close, <0.7 = clearly different. The knob has been left at bestKnobValue in the live lab.',
  };
}

async function inspect({ element, camera }: { element: string; camera?: string }) {
  // Resolve the lab URL the same way capture_views does, then append the
  // ?inspect=<el>&camera=<name> query so the harness boots in solo view.
  const baseUrl = await resolveLabUrl({ element });
  const sep = baseUrl.includes('?') ? '&' : '?';
  const inspectUrl = `${baseUrl}${sep}inspect=${encodeURIComponent(element)}${camera ? `&camera=${encodeURIComponent(camera)}` : ''}`;
  const t0 = Date.now();
  await browserPool.getPage(inspectUrl);
  return {
    element,
    camera: camera ?? null,
    url: inspectUrl,
    navMs: Date.now() - t0,
    hint: 'Right-drag to orbit, scroll to zoom, left-click to pick a mesh. Read .selection from telemetry after the user clicks.',
  };
}

async function openSelection({ editor }: { editor?: string }) {
  // Read the current selection from the telemetry snapshot. The selection
  // is written by the inspect-mode click handler in the browser, then
  // surfaced into /tmp/<project>-state.json on the next telemetry tick.
  if (!existsSync(STATE_PATH)) {
    throw new Error(`No telemetry at ${STATE_PATH} — is the dev server running with a lab open?`);
  }
  const state: any = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  const sel = state?.selection;
  if (!sel?.source?.file) {
    throw new Error('No mesh selected yet. Open the lab in inspect mode and left-click something first.');
  }
  // Convert vite-served URL to a filesystem path: strip protocol+host so
  // `code --goto` resolves it relative to cwd (the project the dev server
  // is serving). Falls through if `file` is already a path.
  const rawFile = String(sel.source.file);
  const fsPath = rawFile
    .replace(/^https?:\/\/[^/]+\//, '')   // strip http://host:port/
    .replace(/^file:\/\//, '')             // strip file://
    .replace(/[?#].*$/, '');               // strip query/hash
  const absPath = fsPath.startsWith('/') ? fsPath : join(process.cwd(), fsPath);
  const line = Number(sel.source.line ?? 1);
  const col = Number(sel.source.col ?? 1);
  // Editor resolution: explicit arg → $EDITOR → `code --goto`. We assume
  // `code` is on PATH for VS Code / Cursor / VSCodium users; others can
  // export $EDITOR (e.g. EDITOR="zed --goto") to override.
  const cmd = editor ?? process.env.EDITOR ?? 'code';
  // `code --goto file:line:col` is the standard VSCode invocation.
  const usesGoto = /code\b/.test(cmd);
  const args = usesGoto ? ['--goto', `${absPath}:${line}:${col}`] : [`${absPath}:${line}:${col}`];
  return await new Promise<{ ok: boolean; cmd: string; args: string[]; file: string; line: number; col: number; stderr?: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: NEED_SHELL });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => reject(new Error(`failed to spawn ${cmd}: ${err.message}`)));
    // Editor commands usually fork-and-detach; don't wait for exit, just
    // confirm we spawned without immediate error.
    setTimeout(() => {
      try { child.unref(); } catch {}
      resolve({ ok: true, cmd, args, file: absPath, line, col, stderr: stderr || undefined });
    }, 200);
  });
}

async function runSmoke({ element }) {
  return new Promise((resolve, reject) => {
    const args = ['smoke'];
    if (element) args.push(element);
    const child = spawn('triscope', args, { stdio: ['ignore', 'pipe', 'pipe'], shell: NEED_SHELL });
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
        inline: { type: 'boolean', description: 'Return images as inline content blocks. Default false — safer for many-camera elements where the inline base64 payload can blow the MCP stdio message budget. Set true only when you specifically want inline.', default: false },
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
    name: 'set_reference_motion',
    description:
      'Capture the CURRENT motion sequence at (element, camera) and save it as the animated reference. Writes <project>/refs/<element>/<camera>.motion.png (filmstrip) + <camera>.motion.json (frames/dt/mode metadata). Use to lock in a known-good animation before risky shader/uniform edits, then diff_reference_motion confirms regressions visually + numerically.',
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string' },
        camera: { type: 'string' },
        frames: { type: 'number', description: 'Default 6.' },
        dt: { type: 'number', description: 'Seconds between frames. Default 0.25.' },
        mode: { type: 'string', enum: ['time', 'real'], description: 'Default "time".' },
        labUrl: { type: 'string' },
      },
      required: ['element', 'camera'],
      additionalProperties: false,
    },
  },
  {
    name: 'diff_reference_motion',
    description:
      'Capture current motion at (element, camera), diff against the saved animated reference. Returns a vertically-stacked composite (reference filmstrip on top, current on bottom) inline AND a scalar motionDiff (0=identical animation, >5=visible drift, >30=clearly different). Requires a prior set_reference_motion for the same (element, camera).',
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string' },
        camera: { type: 'string' },
        frames: { type: 'number' },
        dt: { type: 'number' },
        mode: { type: 'string', enum: ['time', 'real'] },
        labUrl: { type: 'string' },
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
    name: 'health',
    description:
      'Server health snapshot. Returns uptime, dev-server reachability, browser-pool state, pid, recent errors (last 16). Call this when other tools misbehave: a "Connection closed" error from a capture tool followed by a healthy health() call means the MCP server is alive but the browser pool needs to recover; a failed health() means the server itself is sick.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
  {
    name: 'inspect',
    description:
      'Open the lab for an element in interactive inspect mode (solo full-canvas camera + OrbitControls + click-to-pick). Navigates the running browser via CDP to ?inspect=<element>&camera=<name>. Use when the user asks to "inspect" or "open" an element so they can rotate and click parts of it; subsequent clicks populate .selection in telemetry with source file:line.',
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string', description: 'Element to inspect (must match the manifest).' },
        camera: { type: 'string', description: 'Starting camera (defaults to the element\'s first declared camera).' },
      },
      required: ['element'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_selection',
    description:
      'Open the file:line of the currently selected mesh (from inspect mode) in the user\'s editor. Reads .selection.source from the telemetry snapshot and spawns $EDITOR (or `code --goto` by default). Use after the user clicks a mesh and says "open this" / "show me the code".',
    inputSchema: {
      type: 'object',
      properties: {
        editor: { type: 'string', description: 'Override the editor command. Default: $EDITOR or `code`.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'snapshot',
    description:
      'Freeze the current tuning state as a git tag (triscope/snapshot/<name>). Stores the HEAD commit + every persisted knob value across all elements, as JSON inside the tag\'s annotated message — no working-tree files written, no rebase noise. Refuses on a dirty working tree (would silently lose the in-progress edits on restore).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Snapshot name. Must match [A-Za-z0-9._-]+.' },
        message: { type: 'string', description: 'Optional human note for `git show triscope/snapshot/<name>`.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'restore',
    description:
      'Restore a snapshot: git checkout the recorded commit and re-post every knob value via /__knob. Refuses on a dirty working tree. Leaves HEAD detached — branch from there if you want to keep iterating.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Snapshot name (matches `mcp__triscope__list_snapshots`).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_snapshots',
    description:
      'List every triscope snapshot tag in this repo (name, creation date, message subject). Use to find which one to restore.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'auto_tune',
    description:
      'Find the knob value that maximises SSIM (perceptual similarity) between the captured view and a stored reference image, using derivative-free golden-section search. Requires a prior set_reference for (element, target_camera). Iterations: post_knob → wait → captureViews → diff_reference. Use to converge a single shader parameter on a reference photo without manual bisection.',
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string', description: 'Element whose knob to tune.' },
        knob: { type: 'string', description: 'Knob key (must exist on Element.knobs and be type=number).' },
        range: {
          type: 'array',
          description: 'Inclusive [min, max] search bracket. Should cover the knob\'s declared min/max.',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
        },
        target_camera: { type: 'string', description: 'Camera the SSIM is computed on. Must have a stored reference (set_reference first).' },
        max_iterations: { type: 'number', description: 'Cap on knob evaluations. Default 12 (golden section converges to ~0.7% of range).' },
        labUrl: { type: 'string', description: 'Override the lab URL (otherwise resolved like capture_views).' },
      },
      required: ['element', 'knob', 'range', 'target_camera'],
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
    // One info log per tool entry; on the way out either 'succeeded' or
    // 'failed' so a hung/dropped call leaves a half-pair in the log (no
    // succeeded/failed entry → the response never returned, e.g. the
    // process was OOM-killed during JSON encoding).
    const toolStart = Date.now();
    logger.info(`tool:${name}`, 'invoked', { args });
    const finish = (outcome: 'succeeded' | 'failed', extra?: Record<string, unknown>) =>
      logger.info(`tool:${name}`, outcome, { ms: Date.now() - toolStart, ...(extra ?? {}) });
    try {
      const result = await (async () => {
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
            element: args.element as string | undefined,
            labUrl: args.labUrl as string | undefined,
            inline: (args.inline ?? false) as boolean,
          });
          const { _base64ByCam, ...summary } = res;
          // Cap inline payload: 12-camera scenes can produce ~20 MB of base64
          // in a single JSON-RPC message over stdio, which OOM-kills the
          // server process (no catch, no log — Claude Code then auto-respawns
          // us and tools are temporarily unavailable). Auto-downgrade to
          // file paths when over budget and surface a warning so the model
          // knows to Read the files instead.
          let inlineBytes = 0;
          for (const b64 of Object.values(_base64ByCam) as string[]) inlineBytes += b64.length;
          const inlineCapped = res.inline && inlineBytes > INLINE_PAYLOAD_BUDGET;
          const finalInline = res.inline && !inlineCapped;
          const summaryWithWarn = inlineCapped
            ? { ...summary, inline: false, inlineCapped: true,
                inlineWarning: `inline payload would have been ${(inlineBytes / 1048576).toFixed(1)} MB (limit ${(INLINE_PAYLOAD_BUDGET / 1048576).toFixed(0)} MB) — files are on disk, Read them by path.` }
            : summary;
          const text = JSON.stringify(summaryWithWarn, null, 2);
          if (!finalInline) return { content: [{ type: 'text', text }] };
          const content: any[] = [{ type: 'text', text }];
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
          const result = setReference({ cwd: process.cwd(), ...parsed } as any);
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
                ssim: diff.ssim,
                hint: 'meanAbsDiff: 0 = identical, ~30 = visibly close, >80 = clearly different. ssim: 1.0 = identical, 0.9+ = visually close, <0.7 = clearly different. Prefer SSIM for shader convergence (robust to AA noise).',
              }, null, 2) },
              { type: 'image', data: diff.compositeBase64, mimeType: 'image/png' },
            ],
          };
        }
        case 'set_reference_motion': {
          const parsed = z
            .object({
              element: z.string(),
              camera: z.string(),
              frames: z.number().int().min(2).max(32).optional(),
              dt: z.number().positive().max(5).optional(),
              mode: z.enum(['time', 'real']).optional(),
              labUrl: z.string().optional(),
            })
            .parse(args);
          const opts = { frames: parsed.frames ?? 6, dt: parsed.dt ?? 0.25, mode: parsed.mode ?? 'time' };
          const frameB64s = await captureMotionFramesRaw({ ...parsed, ...opts });
          const r = setReferenceMotion({
            cwd: process.cwd(),
            element: parsed.element,
            camera: parsed.camera,
            frameBase64s: frameB64s,
            meta: opts,
          });
          return jsonResult(r);
        }
        case 'diff_reference_motion': {
          const parsed = z
            .object({
              element: z.string(),
              camera: z.string(),
              frames: z.number().int().min(2).max(32).optional(),
              dt: z.number().positive().max(5).optional(),
              mode: z.enum(['time', 'real']).optional(),
              labUrl: z.string().optional(),
            })
            .parse(args);
          const { filmstrip, meta } = refsMotionPaths(process.cwd(), parsed.element, parsed.camera);
          if (!existsSync(filmstrip)) {
            return {
              isError: true,
              content: [{ type: 'text', text: `no motion reference at ${filmstrip}. Call set_reference_motion first.` }],
            };
          }
          // Inherit frame/dt/mode from saved metadata so the comparison is fair.
          let savedMeta: any = {};
          try { savedMeta = existsSync(meta) ? JSON.parse(readFileSync(meta, 'utf8')) : {}; } catch {}
          const opts = {
            frames: parsed.frames ?? savedMeta.frames ?? 6,
            dt: parsed.dt ?? savedMeta.dt ?? 0.25,
            mode: parsed.mode ?? savedMeta.mode ?? 'time',
          };
          const frameB64s = await captureMotionFramesRaw({ ...parsed, ...opts });
          const diff = diffReferenceMotion({
            cwd: process.cwd(),
            element: parsed.element,
            camera: parsed.camera,
            currentFrames: frameB64s,
          });
          return {
            content: [
              { type: 'text', text: JSON.stringify({
                  camera: parsed.camera,
                  refFilmstripPath: diff.refFilmstripPath,
                  refMeta: diff.refMeta,
                  motionDiff: diff.motionDiff,
                  hint: '0 = identical animation, >5 = visible drift, >30 = clearly different',
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
          // Same inline budget guard as capture_views — filmstrips can be
          // even bigger (N frames per camera) so easier to blow the cap.
          let filmstripBytes = 0;
          for (const b64 of Object.values(_filmstripBase64) as string[]) filmstripBytes += b64.length;
          const userWantsInline = parsed.inline !== false;
          const filmstripCapped = userWantsInline && filmstripBytes > INLINE_PAYLOAD_BUDGET;
          const finalInline = userWantsInline && !filmstripCapped;
          const text = JSON.stringify({
            ...summary,
            ...(filmstripCapped
              ? { inlineCapped: true, inlineWarning: `filmstrip payload would have been ${(filmstripBytes / 1048576).toFixed(1)} MB (limit ${(INLINE_PAYLOAD_BUDGET / 1048576).toFixed(0)} MB) — files are on disk, Read them by path.` }
              : {}),
            hint: '<1 = static, >5 = visible motion, >20 = vigorous (in motionMagnitude)',
          }, null, 2);
          if (!finalInline) return { content: [{ type: 'text', text }] };
          const content: any[] = [{ type: 'text', text }];
          for (const cam of res.cameraOrder) {
            const data = _filmstripBase64[cam];
            if (data) content.push({ type: 'image', data, mimeType: 'image/png' });
          }
          return { content };
        }
        case 'health': {
          let devServerOk = false;
          let manifestElements = [];
          try {
            const r = await fetch(`${DEV_URL}/__manifest`, { signal: AbortSignal.timeout(2000) });
            if (r.ok) {
              const m: any = await r.json();
              devServerOk = true;
              manifestElements = Object.keys(m?.elements ?? {});
            }
          } catch {}
          const mem = process.memoryUsage();
          return jsonResult({
            uptimeSec: Math.round((Date.now() - SERVER_START_TIME) / 1000),
            pid: process.pid,
            nodeVersion: process.version,
            project: PROJECT,
            devServer: { url: DEV_URL, reachable: devServerOk, manifestElements },
            memoryMB: {
              rss: +(mem.rss / 1048576).toFixed(1),
              heapUsed: +(mem.heapUsed / 1048576).toFixed(1),
              external: +(mem.external / 1048576).toFixed(1),
            },
            logPath: logger.logPath,
            recentErrors,
          });
        }
        case 'run_smoke':
          return jsonResult(await runSmoke({ element: args.element }));
        case 'inspect': {
          const parsed = z.object({
            element: z.string(),
            camera: z.string().optional(),
          }).parse(args);
          return jsonResult(await inspect({ element: parsed.element, camera: parsed.camera }));
        }
        case 'open_selection': {
          const parsed = z.object({
            editor: z.string().optional(),
          }).parse(args);
          return jsonResult(await openSelection(parsed));
        }
        case 'snapshot': {
          const parsed = z.object({
            name: z.string(),
            message: z.string().optional(),
          }).parse(args);
          return jsonResult(await snapshot({ name: parsed.name, message: parsed.message }));
        }
        case 'restore': {
          const parsed = z.object({ name: z.string() }).parse(args);
          return jsonResult(await restore({ name: parsed.name }));
        }
        case 'list_snapshots':
          return jsonResult(await listSnapshots());
        case 'auto_tune': {
          const parsed = z.object({
            element: z.string(),
            knob: z.string(),
            range: z.tuple([z.number(), z.number()]),
            target_camera: z.string(),
            max_iterations: z.number().int().min(2).max(50).optional(),
            labUrl: z.string().optional(),
          }).parse(args);
          return jsonResult(await autoTune({
            element: parsed.element,
            knob: parsed.knob,
            range: [parsed.range[0], parsed.range[1]],
            target_camera: parsed.target_camera,
            max_iterations: parsed.max_iterations,
            labUrl: parsed.labUrl,
          }));
        }
        default:
          return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
      }
      })();
      finish('succeeded');
      return result;
    } catch (err: any) {
      finish('failed');
      recordError(`tool:${name}`, err);
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
