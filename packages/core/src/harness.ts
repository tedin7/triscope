import * as THREE from 'three/webgpu';
import type { Element, MountContext, MountHandle, CameraSpec, Knob } from './types.js';
import { knobDefault } from './types.js';
import { mountEditor } from './editor.js';
import { MotionProbeBuffer, type ProbeStats } from './motion-probe.js';

declare global {
  interface Window {
    __TRISCOPE__?: TriscopeGlobal;
  }
}

interface TriscopeGlobal {
  element: Element;
  handle: MountHandle;
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  cameras: Record<string, THREE.PerspectiveCamera>;
  knobValues: Record<string, number | string | boolean>;
  setKnob: (key: string, value: number | string | boolean) => void;
  sampleTelemetry: () => Record<string, unknown>;
  /** Capture one frame per named camera; returns base64 PNGs keyed by camera. */
  captureViews: () => Promise<Record<string, string>>;
  /**
   * Capture N frames of a single camera spaced by dt seconds. In `mode: 'time'`
   * (default), the RAF loop is paused and `time.value` is stepped forward
   * deterministically — works for shader-driven motion. In `mode: 'real'`, the
   * RAF keeps running and frames are sampled at wall-clock intervals — needed
   * for CPU-integrated state (springs, particles).
   */
  captureMotionFrames: (
    camera: string,
    opts?: { frames?: number; dt?: number; mode?: 'time' | 'real' },
  ) => Promise<string[]>;
  /** Per-camera GPU probe stats from the most recent captureViews() call. */
  lastGpuProbes?: Record<string, GpuProbeStats>;
}

export interface LabOptions {
  element: Element;
  canvas: HTMLCanvasElement;
  editorContainer?: HTMLElement | null;
  labelContainer?: HTMLElement | null;
  hud?: HTMLElement | null;
  bootOverlay?: HTMLElement | null;
  telemetryIntervalMs?: number;
  knobPollMs?: number;
  /** Optional clear color for the scene before each frame. Default `#0a1a20`. */
  clearColor?: number;
  /**
   * Fixed [width, height] in CSS pixels to which the canvas is resized for
   * every captureViews / captureMotionFrames call, then restored. Use this
   * when you need reproducible framing across page reloads (otherwise the
   * canvas tracks clientWidth/clientHeight which can drift). Off by default.
   */
  captureSize?: [number, number];
}

export interface LabHandle {
  element: Element;
  setKnob: (key: string, value: number | string | boolean) => void;
  captureViews: () => Promise<Record<string, string>>;
  stop: () => void;
}

/**
 * Boot a multi-camera lab page for a single Element.
 * One WebGPURenderer, one scene, one Element, N scissored viewports.
 */
export async function runLab(opts: LabOptions): Promise<LabHandle> {
  const {
    element,
    canvas,
    editorContainer = null,
    labelContainer = null,
    hud = null,
    bootOverlay = null,
    telemetryIntervalMs = 500,
    knobPollMs = 100,
    clearColor = 0x0a1a20,
  } = opts;

  if (!('gpu' in navigator)) {
    throw new Error('navigator.gpu is unavailable — open this page in Chrome/Edge with WebGPU enabled.');
  }

  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(clearColor, 1);
  renderer.autoClear = false;

  const scene = new THREE.Scene();
  const time = { value: 0 };
  const dt = { value: 0 };
  const ctx: MountContext = { renderer, scene, time, dt };

  const handle = element.mount({ parent: scene, ctx });

  // Build PerspectiveCamera per named CameraSpec.
  const cameras: Record<string, THREE.PerspectiveCamera> = {};
  const cameraOrder: string[] = Object.keys(element.cameras);
  for (const [name, spec] of Object.entries(element.cameras)) {
    cameras[name] = makeCamera(spec, element.bounds);
  }

  // Knob state. Persisted values (from a previous session before full-reload)
  // override spec defaults so user-applied tuning survives shader edits.
  const knobValues: Record<string, number | string | boolean> = {};
  const knobs: Record<string, Knob> = element.knobs ?? {};
  let persistedKnobs: Record<string, unknown> = {};
  try {
    const r = await fetch('/__knob/current');
    if (r.ok) {
      const all = (await r.json()) as Record<string, Record<string, unknown>>;
      persistedKnobs = all?.[element.name] ?? {};
    }
  } catch {
    /* dev server transient — fall through to defaults */
  }
  for (const [k, spec] of Object.entries(knobs)) {
    // Trigger knobs have no persistent value and must not fire on mount —
    // they are pure action signals. Skip restore + onKnob for them; the
    // element will receive onKnob only when set_knob is actively called.
    if (spec.type === 'trigger') {
      knobValues[k] = false;
      continue;
    }
    const saved = persistedKnobs[k];
    knobValues[k] = (saved !== undefined ? saved : knobDefault(spec)) as number | string | boolean;
    if (element.onKnob) element.onKnob(handle, k, knobValues[k]);
  }

  // Editor.
  let editor: ReturnType<typeof mountEditor> | null = null;
  if (editorContainer && Object.keys(knobs).length > 0) {
    editor = mountEditor(editorContainer, knobs, knobValues, (key, value) => applyKnob(key, value, false));
  }

  function applyKnob(key: string, value: number | string | boolean, fromExternal: boolean): void {
    const spec = knobs[key];
    if (spec?.type === 'trigger') {
      // Trigger: don't persist value, always pass `true` to onKnob regardless
      // of what the caller passed. The value is purely a pulse signal.
      if (element.onKnob) element.onKnob(handle, key, true);
      if (fromExternal && editor) editor.setValue(key, true);
      return;
    }
    knobValues[key] = value;
    if (element.onKnob) element.onKnob(handle, key, value);
    if (fromExternal && editor) editor.setValue(key, value);
  }

  // Camera labels (HTML overlays) — positioned dynamically each frame.
  const labelEls: Record<string, HTMLDivElement> = {};
  if (labelContainer) {
    for (const name of cameraOrder) {
      const el = document.createElement('div');
      el.className = 'triscope-label';
      el.textContent = name.toUpperCase();
      el.style.position = 'absolute';
      el.style.pointerEvents = 'none';
      el.style.zIndex = '5';
      labelContainer.appendChild(el);
      labelEls[name] = el;
    }
  }

  // Post the element manifest once on boot so MCP can discover it.
  postManifest({
    element: element.name,
    labUrl: element.labUrl ?? (typeof window !== 'undefined' ? window.location.pathname : undefined),
    cameras: Object.entries(element.cameras).map(([n, c]) => ({ name: n, ...c })),
    knobs: Object.entries(knobs).map(([n, k]) => ({ name: n, ...k, current: knobValues[n] })),
  }).catch(() => {});

  // FPS + frame loop state.
  let frames = 0;
  let fpsWindowMs = 0;
  let fps = 0;
  let lastT = performance.now();
  let lastTelemetryT = 0;
  let lastKnobPollT = 0;
  let running = true;

  // Motion-probe ring buffers (one per declared probe key). 120 samples ≈ 2 s
  // at 60 fps; we expose summary stats + the last 32 samples in telemetry.
  const probeKeys = Object.keys(element.motionProbes ?? {});
  const probeBuffers: Record<string, MotionProbeBuffer> = {};
  for (const k of probeKeys) probeBuffers[k] = new MotionProbeBuffer(120);

  function resize(): void {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    // Update aspect for all cameras.
    const n = cameraOrder.length;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const paneW = w / cols;
    const paneH = h / rows;
    for (const name of cameraOrder) {
      cameras[name].aspect = paneW / Math.max(paneH, 1);
      cameras[name].updateProjectionMatrix();
    }
    if (labelContainer) {
      cameraOrder.forEach((name, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const el = labelEls[name];
        if (!el) return;
        el.style.left = `${col * paneW + 8}px`;
        el.style.top = `${row * paneH + 8}px`;
      });
    }
  }
  window.addEventListener('resize', resize);
  resize();

  function renderAll(): void {
    const n = cameraOrder.length;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const w = renderer.domElement.width / renderer.getPixelRatio();
    const h = renderer.domElement.height / renderer.getPixelRatio();
    const paneW = w / cols;
    const paneH = h / rows;
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.setScissorTest(true);
    cameraOrder.forEach((name, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * paneW;
      // Three.js viewport origin is bottom-left; flip rows.
      const y = (rows - 1 - row) * paneH;
      renderer.setViewport(x, y, paneW, paneH);
      renderer.setScissor(x, y, paneW, paneH);
      renderer.render(scene, cameras[name]);
    });
    renderer.setScissorTest(false);
  }

  function tick(): void {
    if (!running) return;
    const now = performance.now();
    const delta = (now - lastT) / 1000;
    lastT = now;
    time.value += delta;
    dt.value = delta;
    fpsWindowMs += delta * 1000;
    frames += 1;
    if (fpsWindowMs > 500) {
      fps = (frames * 1000) / fpsWindowMs;
      frames = 0;
      fpsWindowMs = 0;
      if (hud) hud.textContent = `${fps.toFixed(0)} fps · WebGPU · ${element.name}`;
    }

    // Sample motion probes before render so they see the just-advanced time.
    if (probeKeys.length > 0 && element.motionProbes) {
      for (const k of probeKeys) {
        try {
          const v = element.motionProbes[k](handle, ctx);
          if (Number.isFinite(v)) probeBuffers[k].push(v, time.value);
        } catch {
          /* probe failures must not break the loop */
        }
      }
    }

    renderAll();

    if (now - lastTelemetryT > telemetryIntervalMs) {
      lastTelemetryT = now;
      postState(buildState()).catch(() => {});
    }
    if (now - lastKnobPollT > knobPollMs) {
      lastKnobPollT = now;
      pollKnobs().catch(() => {});
    }

    requestAnimationFrame(tick);
  }

  function buildState(): Record<string, unknown> {
    const elemTelemetry = element.telemetry ? safe(() => element.telemetry!(handle, ctx)) : {};
    let motion: Record<string, ProbeStats | null> | undefined;
    if (probeKeys.length > 0) {
      motion = {};
      for (const k of probeKeys) {
        motion[k] = probeBuffers[k].stats();
      }
    }
    return {
      project: element.name,
      perf: { fps, dpr: renderer.getPixelRatio() },
      time: time.value,
      knobs: { ...knobValues },
      cameras: Object.fromEntries(
        cameraOrder.map((n) => [
          n,
          {
            position: cameras[n].position.toArray(),
            target: targetOf(cameras[n]),
            fov: cameras[n].fov,
          },
        ]),
      ),
      elements: {
        [element.name]: motion ? { ...elemTelemetry, motion } : elemTelemetry,
      },
    };
  }

  async function pollKnobs(): Promise<void> {
    try {
      const res = await fetch('/__knob');
      if (!res.ok) return;
      const drained = (await res.json()) as Array<{ element?: string; key: string; value: unknown }>;
      if (!Array.isArray(drained) || drained.length === 0) return;
      for (const entry of drained) {
        if (entry.element && entry.element !== element.name) continue;
        if (typeof entry.key !== 'string') continue;
        applyKnob(entry.key, entry.value as number | string | boolean, true);
      }
    } catch {
      /* dev server may be transient */
    }
  }

  async function captureMotionFrames(
    cameraName: string,
    motionOpts: { frames?: number; dt?: number; mode?: 'time' | 'real' } = {},
  ): Promise<string[]> {
    const { frames: N = 6, dt: step = 0.25, mode = 'time' } = motionOpts;
    const cam = cameras[cameraName];
    if (!cam) throw new Error(`unknown camera: ${cameraName}`);
    // If captureSize is set, snap the canvas to that fixed size for the
    // capture (and restore at the end) so framing is deterministic across
    // page reloads / window resizes.
    const liveW = renderer.domElement.width / renderer.getPixelRatio();
    const liveH = renderer.domElement.height / renderer.getPixelRatio();
    const w = opts.captureSize?.[0] ?? liveW;
    const h = opts.captureSize?.[1] ?? liveH;
    if (opts.captureSize) renderer.setSize(w, h, false);
    renderer.setScissorTest(false);
    cam.aspect = w / Math.max(h, 1);
    cam.updateProjectionMatrix();

    const out: string[] = [];
    if (mode === 'time') {
      // Deterministic: pause the RAF, step time.value forward, render.
      // CRITICAL: Three.js TSL's `time` node is `uniform(0).onRenderUpdate(
      // (frame) => frame.time)` — it overwrites itself from renderer.nodeFrame
      // on every render. So we must also override nodeFrame.time before each
      // render or any shader using three/tsl's `time` will appear frozen.
      const wasRunning = running;
      running = false;
      // Fully deterministic: always start the captured sequence at t=0 so
      // two captures of the same element+shader produce byte-identical
      // frames (no dependency on when captureMotionFrames was invoked).
      const baseT = 0;
      const baseDt = dt.value;
      const liveTime = time.value;
      const rendererAny = renderer as unknown as {
        nodeFrame?: { time: number; deltaTime: number };
        _nodes?: { nodeFrame?: { time: number; deltaTime: number } };
      };
      const nf = rendererAny.nodeFrame ?? rendererAny._nodes?.nodeFrame ?? null;
      const baseFrameT = nf?.time ?? 0;
      const baseFrameDt = nf?.deltaTime ?? 0;
      try {
        for (let i = 0; i < N; i++) {
          const wantedT = baseT + i * step;
          time.value = wantedT;
          dt.value = step;
          if (nf) {
            nf.time = wantedT;
            nf.deltaTime = step;
          }
          renderer.setViewport(0, 0, w, h);
          renderer.clear();
          renderer.render(scene, cam);
          out.push(renderer.domElement.toDataURL('image/png'));
        }
      } finally {
        time.value = liveTime;     // restore the live RAF-accumulated time
        dt.value = baseDt;
        if (nf) {
          nf.time = baseFrameT;
          nf.deltaTime = baseFrameDt;
        }
        running = wasRunning;
        if (running) {
          lastT = performance.now();
          requestAnimationFrame(tick);
        }
      }
    } else {
      // Real-time: keep RAF running, sample at wall-clock intervals.
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < N; i++) {
        renderer.setViewport(0, 0, w, h);
        renderer.setScissorTest(false);
        renderer.clear();
        renderer.render(scene, cam);
        out.push(renderer.domElement.toDataURL('image/png'));
        if (i < N - 1) await sleep(step * 1000);
      }
    }
    resize();
    return out;
  }

  async function captureViews(): Promise<Record<string, string>> {
    // Capture each camera as a separate full-canvas render to a base64 PNG.
    // Side effect: per-camera built-in GPU probe stats (luminance, dynamic
    // range) are computed by decoding the just-written canvas via 2D context
    // and saved into `__TRISCOPE__.lastGpuProbes` so MCP can read them.
    const out: Record<string, string> = {};
    const probeStats: Record<string, GpuProbeStats> = {};
    const liveW = renderer.domElement.width / renderer.getPixelRatio();
    const liveH = renderer.domElement.height / renderer.getPixelRatio();
    const w = opts.captureSize?.[0] ?? liveW;
    const h = opts.captureSize?.[1] ?? liveH;
    if (opts.captureSize) renderer.setSize(w, h, false);
    for (const name of cameraOrder) {
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, w, h);
      renderer.clear();
      cameras[name].aspect = w / Math.max(h, 1);
      cameras[name].updateProjectionMatrix();
      renderer.render(scene, cameras[name]);
      // The canvas now holds this camera's view. Read as data URL.
      out[name] = renderer.domElement.toDataURL('image/png');
      // Compute GPU probe stats from the same render. We sample 64×36 px
      // (≈2300 samples) — enough for stable luminance percentiles without
      // making toBlob+getImageData a per-camera bottleneck.
      probeStats[name] = sampleGpuProbes(renderer.domElement);
    }
    if (typeof window !== 'undefined') {
      (window.__TRISCOPE__ as any).lastGpuProbes = probeStats;
    }
    // Restore live canvas dimensions + per-camera aspect ratios.
    resize();
    return out;
  }

  if (bootOverlay) bootOverlay.remove();

  window.__TRISCOPE__ = {
    element,
    handle,
    renderer,
    scene,
    cameras,
    knobValues,
    setKnob: (k, v) => applyKnob(k, v, true),
    sampleTelemetry: buildState,
    captureViews,
    captureMotionFrames,
  };

  requestAnimationFrame(tick);

  return {
    element,
    setKnob: (k, v) => applyKnob(k, v, true),
    captureViews,
    stop: () => {
      running = false;
      window.removeEventListener('resize', resize);
      handle.dispose();
      renderer.dispose();
    },
  };
}

/**
 * Aggregated brightness/contrast scalars computed from a rendered canvas.
 * Probes are run by the harness during `captureViews()` — they validate
 * that the GPU actually drew something (luminance > 0 means the frame is
 * not black; p95/p5 ratio > 1 means there's contrast).
 */
export interface GpuProbeStats {
  /** Mean perceptual luminance (Rec.709) in [0, 1]. */
  luminance: number;
  /** 5th percentile luminance. */
  p5: number;
  /** 95th percentile luminance. */
  p95: number;
  /** p95 / max(p5, 1/255) — dynamic range proxy. */
  dynamicRange: number;
  /** Number of pixels sampled (typically 64×36 = 2304). */
  samples: number;
}

const PROBE_SAMPLE_W = 64;
const PROBE_SAMPLE_H = 36;
let probeSampler: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;

function sampleGpuProbes(srcCanvas: HTMLCanvasElement): GpuProbeStats {
  // Reuse a single 64×36 2D scratch canvas so we don't allocate per frame.
  if (!probeSampler) {
    const c = document.createElement('canvas');
    c.width = PROBE_SAMPLE_W;
    c.height = PROBE_SAMPLE_H;
    probeSampler = { canvas: c, ctx: c.getContext('2d', { willReadFrequently: true })! };
  }
  const { canvas: sc, ctx } = probeSampler;
  ctx.clearRect(0, 0, sc.width, sc.height);
  // drawImage scales the WebGPU canvas down to our sample size in one call.
  ctx.drawImage(srcCanvas, 0, 0, sc.width, sc.height);
  const data = ctx.getImageData(0, 0, sc.width, sc.height).data;
  const n = sc.width * sc.height;
  const lums = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i * 4] / 255;
    const g = data[i * 4 + 1] / 255;
    const b = data[i * 4 + 2] / 255;
    // Rec.709 luminance.
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lums[i] = lum;
    sum += lum;
  }
  const sorted = Array.from(lums).sort((a, b) => a - b);
  const p5 = sorted[Math.floor(n * 0.05)];
  const p95 = sorted[Math.floor(n * 0.95)];
  const luminance = sum / n;
  const dynamicRange = p95 / Math.max(p5, 1 / 255);
  return {
    luminance: +luminance.toFixed(4),
    p5: +p5.toFixed(4),
    p95: +p95.toFixed(4),
    dynamicRange: +dynamicRange.toFixed(2),
    samples: n,
  };
}

function makeCamera(spec: CameraSpec, bounds?: Element['bounds']): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(spec.fov ?? 45, 1, spec.near ?? 0.1, spec.far ?? 2000);
  cam.position.set(...spec.position);
  cam.lookAt(...spec.target);
  cam.userData.target = [...spec.target] as [number, number, number];
  if (spec.fit && bounds) {
    fitCameraToBounds(cam, spec, bounds);
  }
  return cam;
}

function fitCameraToBounds(
  cam: THREE.PerspectiveCamera,
  spec: CameraSpec,
  bounds: NonNullable<Element['bounds']>,
): void {
  const min = new THREE.Vector3(...bounds.min);
  const max = new THREE.Vector3(...bounds.max);
  const center = min.clone().add(max).multiplyScalar(0.5);
  const size = max.clone().sub(min).length();
  const target = new THREE.Vector3(...spec.target);
  const fovRad = (cam.fov * Math.PI) / 180;
  const distance = size / (2 * Math.tan(fovRad / 2));
  const dir = cam.position.clone().sub(target).normalize();
  cam.position.copy(center.clone().add(dir.multiplyScalar(distance * 1.2)));
  cam.lookAt(center);
  cam.userData.target = [center.x, center.y, center.z];
}

function targetOf(cam: THREE.PerspectiveCamera): [number, number, number] {
  const t = cam.userData?.target;
  if (Array.isArray(t) && t.length === 3) return [t[0], t[1], t[2]];
  const fallback = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).add(cam.position);
  return [fallback.x, fallback.y, fallback.z];
}

async function postState(payload: Record<string, unknown>): Promise<void> {
  await fetch('/__state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function postManifest(payload: Record<string, unknown>): Promise<void> {
  await fetch('/__manifest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function safe<T>(fn: () => T): T | Record<string, never> {
  try {
    return fn();
  } catch {
    return {};
  }
}
