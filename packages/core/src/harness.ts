import * as THREE from 'three/webgpu';
import type { Element, MountContext, MountHandle, CameraSpec, Knob } from './types.js';
import { knobDefault } from './types.js';
import { mountEditor } from './editor.js';

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

  // Knob state.
  const knobValues: Record<string, number | string | boolean> = {};
  const knobs: Record<string, Knob> = element.knobs ?? {};
  for (const [k, spec] of Object.entries(knobs)) {
    knobValues[k] = knobDefault(spec);
    if (element.onKnob) element.onKnob(handle, k, knobValues[k]);
  }

  // Editor.
  let editor: ReturnType<typeof mountEditor> | null = null;
  if (editorContainer && Object.keys(knobs).length > 0) {
    editor = mountEditor(editorContainer, knobs, knobValues, (key, value) => applyKnob(key, value, false));
  }

  function applyKnob(key: string, value: number | string | boolean, fromExternal: boolean): void {
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
        [element.name]: elemTelemetry,
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

  async function captureViews(): Promise<Record<string, string>> {
    // Capture each camera as a separate full-canvas render to a base64 PNG.
    const out: Record<string, string> = {};
    const w = renderer.domElement.width / renderer.getPixelRatio();
    const h = renderer.domElement.height / renderer.getPixelRatio();
    for (const name of cameraOrder) {
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, w, h);
      renderer.clear();
      cameras[name].aspect = w / Math.max(h, 1);
      cameras[name].updateProjectionMatrix();
      renderer.render(scene, cameras[name]);
      // The canvas now holds this camera's view. Read as data URL.
      out[name] = renderer.domElement.toDataURL('image/png');
    }
    // Restore aspect ratios.
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
