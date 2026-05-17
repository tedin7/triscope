/**
 * Inspect mode: solo-view + OrbitControls + raycaster picking + hover
 * highlight + click-to-select. Writes selection into
 * window.__TRISCOPE__.lastSelection so MCP read_telemetry .selection
 * surfaces the source frame for the picked mesh.
 *
 * Activation: URL `?inspect=<element>&camera=<name>` (camera optional, falls
 * back to the first declared camera). When inactive the harness behaves
 * exactly as before — the grid view.
 *
 * Highlight is a single shared wireframe Mesh that borrows the hovered
 * object's geometry (no per-frame allocation). Click-selection persists
 * the same overlay with a different color until the next click.
 */
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SourceTag } from './source-tag.js';

export interface InspectSelection {
  /** Camera the click came from. */
  camera: string;
  /** World-space hit position. */
  point: [number, number, number];
  /** Distance from camera to hit. */
  distance: number;
  /** Tag from the auto source-tag patch. May drift in vite dev — see note in source-tag.ts. */
  source: SourceTag['source'];
  stack: SourceTag['stack'];
  type: string;
  geometry?: string;
  material?: SourceTag['material'];
  /** Object name if author set Object3D.name. */
  name?: string;
  /**
   * Object name chain, root → immediate parent → self. Useful as a
   * cross-check when `source.line` drifts: even if the line is off,
   * "the cyan mesh inside group 'mainmast' inside scene" disambiguates.
   */
  parentChain: string[];
  /** Object UUID — stable for the duration of the session. */
  uuid: string;
}

function buildParentChain(obj: THREE.Object3D): string[] {
  const chain: string[] = [];
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    chain.unshift(describeObj(cur));
    cur = (cur as any).parent ?? null;
  }
  return chain;
}

/**
 * Compact human-readable description of an Object3D used in parentChain
 * and clipboard formats. Prefers the author's `.name` (most specific);
 * falls back to a self-describing shorthand like `Mesh<PlaneGeometry
 * #e6dcc0>` so the user can still grep — even when no names are set on
 * the scene tree.
 */
function describeObj(obj: THREE.Object3D): string {
  if (obj.name) return obj.name;
  const ctor = obj.constructor?.name ?? '?';
  const mesh = obj as THREE.Mesh;
  const geom = mesh.geometry?.type;
  let color: string | undefined;
  try {
    const mat = mesh.material as { color?: { getHexString?: () => string } };
    if (mat?.color?.getHexString) color = '#' + mat.color.getHexString();
  } catch { /* color extraction is best-effort */ }
  if (geom || color) {
    const parts = [geom, color].filter(Boolean).join(' ');
    return `${ctor}<${parts}>`;
  }
  return ctor;
}

export interface InspectMode {
  active: boolean;
  cameraName: string | null;
  camera: THREE.PerspectiveCamera | null;
  /** Renders the solo view for this frame. Call instead of grid renderAll(). */
  render(): void;
  /** Pull current hover/selection state. */
  state(): { hover: InspectSelection | null; selection: InspectSelection | null; selections: InspectSelection[] };
  dispose(): void;
}

export interface InspectInit {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  cameras: Record<string, THREE.PerspectiveCamera>;
  /** Element name used for the manifest match. */
  elementName: string;
  /** Canvas the user clicks on. */
  canvas: HTMLCanvasElement;
  /**
   * Called when selection changes. `sel` is the most-recently-clicked
   * mesh (or null on background click), `all` is the full multi-select
   * set including this one. Multi-select is built with Shift+click;
   * a plain click clears the set and starts fresh with one item.
   */
  onSelectionChange: (sel: InspectSelection | null, all: InspectSelection[]) => void;
}

/**
 * Walk the scene tree and return the first Mesh whose source tag matches
 * the given frame (same file + line). Used by inspect-mode persistence to
 * restore the selection across full-reload — the Mesh object identity
 * changes after reload but the source location is stable.
 */
function findMeshBySource(
  scene: THREE.Scene,
  source: SourceTag['source'] | null,
): THREE.Object3D | null {
  if (!source?.file) return null;
  let match: THREE.Object3D | null = null;
  (scene as any).traverse?.((obj: THREE.Object3D) => {
    if (match) return;
    const tag = obj.userData?.__tris as SourceTag | undefined;
    if (!tag?.source) return;
    if (tag.source.file === source.file && tag.source.line === source.line) {
      match = obj;
    }
  });
  return match;
}

/** Parse the URL for inspect activation. Returns null when off. */
export function readInspectFromUrl(elementName: string): { camera?: string } | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const inspectParam = params.get('inspect');
  if (inspectParam == null) return null;
  // `?inspect`, `?inspect=1`, `?inspect=<el>` all activate.
  // `?inspect=<el>` activates only when the el matches our element.
  if (inspectParam === '' || inspectParam === '1' || inspectParam === elementName) {
    return { camera: params.get('camera') ?? undefined };
  }
  return null;
}

export function createInspectMode(init: InspectInit & { cameraName?: string }): InspectMode {
  const cameraName = init.cameraName ?? Object.keys(init.cameras)[0];
  const camera = init.cameras[cameraName];
  if (!camera) {
    return {
      active: false,
      cameraName: null,
      camera: null,
      render: () => {},
      state: () => ({ hover: null, selection: null, selections: [] }),
      dispose: () => {},
    };
  }

  // OrbitControls — right-button rotates per user request, left-button is
  // reserved for picking (we wire click → raycast below). Scroll zooms.
  const controls = new OrbitControls(camera, init.canvas);
  controls.enablePan = true;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.mouseButtons = {
    LEFT: null as any, // we handle left clicks for picking
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.ROTATE,
  };
  // OrbitControls' target defaults to (0,0,0); use the camera's declared target.
  const t = camera.userData?.target;
  if (Array.isArray(t) && t.length === 3) controls.target.set(t[0], t[1], t[2]);
  controls.update();

  // Highlight overlay: one wireframe mesh whose geometry is swapped to
  // match the hovered/selected mesh. Bright green for hover, bright cyan
  // for the persistent click-selection. `raycast` is a no-op so the
  // overlay never grabs subsequent picks.
  const hoverMat = new THREE.MeshBasicNodeMaterial({
    color: 0x66ff66, wireframe: true, transparent: true, opacity: 0.9, depthTest: false,
  });
  const selectMat = new THREE.MeshBasicNodeMaterial({
    color: 0x00ffff, wireframe: true, transparent: true, opacity: 0.95, depthTest: false,
  });
  const overlay = new THREE.Mesh(new THREE.BufferGeometry(), hoverMat);
  overlay.renderOrder = 999;
  overlay.frustumCulled = false;
  overlay.visible = false;
  overlay.raycast = () => {}; // ignore in picking
  init.scene.add(overlay);
  const selectOverlay = new THREE.Mesh(new THREE.BufferGeometry(), selectMat);
  selectOverlay.renderOrder = 1000;
  selectOverlay.frustumCulled = false;
  selectOverlay.visible = false;
  selectOverlay.raycast = () => {};
  init.scene.add(selectOverlay);

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hoverHit: InspectSelection | null = null;
  let selectionHit: InspectSelection | null = null;
  let hoveredObject: THREE.Object3D | null = null;
  let selectedObject: THREE.Object3D | null = null;
  // Multi-select state. selectionsByUuid maps uuid → selection. extraOverlays
  // maps uuid → its wireframe overlay Mesh (the primary cyan overlay is
  // reserved for the most-recently-clicked item, kept in sync with
  // selectedObject). Built up via Shift+click; plain click resets.
  const selectionsByUuid = new Map<string, InspectSelection>();
  const extraOverlaysByUuid = new Map<string, THREE.Mesh>();
  const extraOverlayMat = new THREE.MeshBasicNodeMaterial({
    color: 0x00ccff, wireframe: true, transparent: true, opacity: 0.75, depthTest: false,
  });

  function eventToNdc(ev: MouseEvent): void {
    const rect = init.canvas.getBoundingClientRect();
    ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function pick(): { obj: THREE.Object3D; distance: number; point: THREE.Vector3 } | null {
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(init.scene.children, true);
    // Filter out overlays + lights + non-mesh helpers.
    for (const h of hits) {
      if (h.object === overlay || h.object === selectOverlay) continue;
      if (!(h.object as THREE.Mesh).isMesh) continue;
      return { obj: h.object, distance: h.distance, point: h.point };
    }
    return null;
  }

  function selectionFrom(hit: { obj: THREE.Object3D; distance: number; point: THREE.Vector3 }): InspectSelection {
    const tag = (hit.obj.userData?.__tris as SourceTag | undefined) ?? null;
    return {
      camera: cameraName,
      point: [hit.point.x, hit.point.y, hit.point.z],
      distance: +hit.distance.toFixed(3),
      source: tag?.source ?? null,
      stack: tag?.stack ?? [],
      type: tag?.type ?? hit.obj.constructor.name,
      geometry: tag?.geometry,
      material: tag?.material,
      name: tag?.name ?? hit.obj.name ?? undefined,
      parentChain: buildParentChain(hit.obj),
      uuid: hit.obj.uuid,
    };
  }

  function syncOverlayTo(target: THREE.Mesh, which: THREE.Mesh): void {
    which.geometry = target.geometry;
    target.updateMatrixWorld(true);
    which.matrix.copy(target.matrixWorld);
    which.matrixAutoUpdate = false;
    which.visible = true;
  }

  // mousemove → hover (RAF-throttled so we don't raycast 1000x/s).
  let pendingHover = false;
  function onMouseMove(ev: MouseEvent): void {
    eventToNdc(ev);
    if (pendingHover) return;
    pendingHover = true;
    requestAnimationFrame(() => {
      pendingHover = false;
      const hit = pick();
      if (!hit) {
        if (hoveredObject) {
          hoveredObject = null;
          hoverHit = null;
          overlay.visible = false;
        }
        return;
      }
      if (hit.obj === hoveredObject) return;
      hoveredObject = hit.obj;
      hoverHit = selectionFrom(hit);
      syncOverlayTo(hit.obj as THREE.Mesh, overlay);
    });
  }

  function clearMultiOverlays(): void {
    for (const ov of extraOverlaysByUuid.values()) init.scene.remove(ov);
    extraOverlaysByUuid.clear();
    selectionsByUuid.clear();
  }

  function ensureMultiOverlay(uuid: string, target: THREE.Mesh): void {
    if (extraOverlaysByUuid.has(uuid)) {
      // Already overlaid; just re-sync transform in case the mesh moved.
      syncOverlayTo(target, extraOverlaysByUuid.get(uuid)!);
      return;
    }
    const ov = new THREE.Mesh(new THREE.BufferGeometry(), extraOverlayMat);
    ov.renderOrder = 1000;
    ov.frustumCulled = false;
    ov.raycast = () => {};
    init.scene.add(ov);
    extraOverlaysByUuid.set(uuid, ov);
    syncOverlayTo(target, ov);
  }

  /**
   * Best-effort clipboard write — silently ignores rejections on browsers
   * that gate navigator.clipboard behind a user-activation check (it's
   * fine here because we're called from a click event handler).
   *
   * Format is rich enough to grep with when source.line drifts (which it
   * does, because Error.stack in browsers reports positions in the
   * vite-served file, not source-mapped originals). Example output:
   *   PirateShipMesh.ts:1599 — Mesh<PlaneGeometry #e6dcc0> @ (4.2,8.1,0.3) chain=Scene>pirate.ship>mainmast>Mesh<PlaneGeometry #e6dcc0>
   * The user can paste this into chat or `rg` and find the real call
   * site even if the line number is off by 100 lines.
   */
  function copySelection(sel: InspectSelection): void {
    const src = sel.source;
    const fileLine = src ? `${src.file.split('/').slice(-1)[0]}:${src.line}` : `(uuid=${sel.uuid})`;
    const desc = sel.name ?? `${sel.type}<${[sel.geometry, sel.material?.color].filter(Boolean).join(' ')}>`;
    const pos = `(${sel.point.map((n) => n.toFixed(2)).join(',')})`;
    const chain = sel.parentChain?.length ? ` chain=${sel.parentChain.join('>')}` : '';
    const text = `${fileLine} — ${desc} @ ${pos}${chain}`;
    try { (navigator as any).clipboard?.writeText(text); } catch {}
  }

  function onMouseDown(ev: MouseEvent): void {
    if (ev.button !== 0) return; // left only
    eventToNdc(ev);
    const hit = pick();
    if (!hit) {
      // Plain background click clears everything; Shift+background keeps
      // the current multi-set so the user can de-target a stray click.
      if (!ev.shiftKey) {
        selectionHit = null;
        selectedObject = null;
        selectOverlay.visible = false;
        clearMultiOverlays();
        init.onSelectionChange(null, []);
        try { window.localStorage.removeItem(STORAGE_KEY); } catch {}
      }
      return;
    }
    const sel = selectionFrom(hit);
    if (!ev.shiftKey) {
      // Plain click: replace set with this one item.
      clearMultiOverlays();
    } else if (selectedObject && selectionHit) {
      // Shift+click on a NEW mesh: the previous "primary" is about to lose
      // the primary overlay (which will swap to the new mesh). Give the
      // old primary its own multi-overlay so it stays visible. Without
      // this the user sees only the latest pick, not the accumulated set.
      ensureMultiOverlay(selectionHit.uuid, selectedObject as THREE.Mesh);
    }
    selectedObject = hit.obj;
    selectionHit = sel;
    syncOverlayTo(hit.obj as THREE.Mesh, selectOverlay);
    selectionsByUuid.set(sel.uuid, sel);
    init.onSelectionChange(sel, [...selectionsByUuid.values()]);
    copySelection(sel);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sel));
    } catch {}
  }

  init.canvas.addEventListener('mousemove', onMouseMove);
  init.canvas.addEventListener('mousedown', onMouseDown);

  // Restore last selection across full-reload (vite force-reload on
  // shader edits). Match by source frame (file:line) — the actual Mesh
  // object is new after reload but the source location is stable.
  //
  // Element mounting may happen across many frames (TSL pipeline init,
  // async texture loads, RAF-driven sub-mesh adds). Poll up to ~3 s
  // looking for the stored source in the scene tree, so we don't give
  // up before the element has finished assembling itself.
  const STORAGE_KEY = `triscope:selection:${init.elementName}`;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as InspectSelection;
      let attempts = 0;
      const maxAttempts = 30; // 30 × 100ms ≈ 3s
      const tryRestore = () => {
        attempts += 1;
        try {
          const target = findMeshBySource(init.scene, stored.source);
          if (target) {
            selectedObject = target;
            selectionHit = selectionFrom({
              obj: target,
              distance: stored.distance,
              point: new THREE.Vector3(...stored.point),
            } as any);
            syncOverlayTo(target as THREE.Mesh, selectOverlay);
            selectionsByUuid.set(selectionHit.uuid, selectionHit);
            init.onSelectionChange(selectionHit, [...selectionsByUuid.values()]);
            return;
          }
        } catch { /* corrupt stored selection — drop it */
          try { window.localStorage.removeItem(STORAGE_KEY); } catch {}
          return;
        }
        if (attempts < maxAttempts) setTimeout(tryRestore, 100);
      };
      setTimeout(tryRestore, 100);
    }
  } catch { /* localStorage unavailable — silent */ }

  function render(): void {
    controls.update();
    // Keep overlays glued to their target's current world matrix in case
    // the underlying mesh moved (animation, knob change).
    if (selectedObject && selectionHit) {
      selectedObject.updateMatrixWorld(true);
      selectOverlay.matrix.copy(selectedObject.matrixWorld);
    }
    if (hoveredObject) {
      hoveredObject.updateMatrixWorld(true);
      overlay.matrix.copy(hoveredObject.matrixWorld);
    }
    init.renderer.setScissorTest(false);
    const w = init.renderer.domElement.width / init.renderer.getPixelRatio();
    const h = init.renderer.domElement.height / init.renderer.getPixelRatio();
    init.renderer.setViewport(0, 0, w, h);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
    init.renderer.clear();
    init.renderer.render(init.scene, camera);
  }

  function dispose(): void {
    init.canvas.removeEventListener('mousemove', onMouseMove);
    init.canvas.removeEventListener('mousedown', onMouseDown);
    init.scene.remove(overlay);
    init.scene.remove(selectOverlay);
    controls.dispose();
  }

  return {
    active: true,
    cameraName,
    camera,
    render,
    state: () => ({ hover: hoverHit, selection: selectionHit, selections: [...selectionsByUuid.values()] }),
    dispose,
  };
}
