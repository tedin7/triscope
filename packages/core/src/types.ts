import type * as THREE from 'three/webgpu';

/** A position+target camera preset for one pane of the lab grid. */
export interface CameraSpec {
  position: [number, number, number];
  target: [number, number, number];
  /** Vertical FOV in degrees. Default 45. */
  fov?: number;
  /** If true, auto-fit element bounds into the camera frame. */
  fit?: boolean;
  /** Near clip. Default 0.1. */
  near?: number;
  /** Far clip. Default 2000. */
  far?: number;
}

/** A tunable knob exposed to the slider editor and the MCP `set_knob` tool. */
export type Knob =
  | { type: 'number'; min: number; max: number; step?: number; default: number; label?: string }
  | { type: 'int'; min: number; max: number; default: number; label?: string }
  | { type: 'color'; default: string; label?: string }
  | { type: 'boolean'; default: boolean; label?: string };

/** Context passed to `Element.mount`. */
export interface MountContext {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  /** Shared time uniform (seconds). Updated each frame by the harness. */
  time: { value: number };
  /** dt in seconds, last frame. */
  dt: { value: number };
}

/** The handle returned by `Element.mount`. */
export interface MountHandle {
  /** The root Object3D the element added to the scene. */
  root: THREE.Object3D;
  /** Tear-down hook. Must remove the element from the scene and free GPU resources. */
  dispose: () => void;
  /** Element-specific data the telemetry/onKnob callbacks may need. */
  userData?: Record<string, unknown>;
}

/**
 * A self-describing 3D element. The triscope lab harness consumes this
 * to render a multi-camera grid, drive a tunables UI, post telemetry,
 * and run the smoke test. Composition is just an element whose `mount`
 * mounts other elements.
 */
export interface Element {
  name: string;
  mount: (args: { parent: THREE.Object3D; ctx: MountContext }) => MountHandle;
  /**
   * Optional override for the lab page URL. Either a path relative to the
   * dev server (`/triscope-ship.html`) or a full URL. When set, the harness
   * publishes it on the manifest so the MCP/CLI can route `capture_views`
   * and `run_smoke` to the right page without hardcoding `/labs/<name>.html`.
   */
  labUrl?: string;
  /** Local-space bounding box. Used for auto-fitting cameras and the scene framing. */
  bounds?: { min: [number, number, number]; max: [number, number, number] };
  /** Named camera presets. Each becomes one pane in the lab grid. */
  cameras: Record<string, CameraSpec>;
  /** Tunable knobs. Rendered as sliders + exposed to MCP `set_knob`. */
  knobs?: Record<string, Knob>;
  /** Live-update hook. Called when a knob changes; must apply the change without rebuilding pipelines. */
  onKnob?: (handle: MountHandle, key: string, value: number | string | boolean) => void;
  /** Per-frame state to publish via the telemetry sink. Return JSON-serializable values. */
  telemetry?: (handle: MountHandle, ctx: MountContext) => Record<string, unknown>;
  /**
   * Named per-frame numeric probes for animated state. The harness samples each
   * every frame, keeps a ring buffer (~2 s at 60 fps), and exposes summary stats
   * under `telemetry.elements.<name>.motion.<probeKey>`:
   *   { latest, mean, min, max, peakToPeak, samples: lastN }
   * Use for amplitude (vertex displacement), oscillation rate, particle counts —
   * anything dynamic the Element wants to quantify.
   */
  motionProbes?: Record<string, (handle: MountHandle, ctx: MountContext) => number>;
}

/** Default value extracted from a knob spec. */
export function knobDefault(k: Knob): number | string | boolean {
  return k.default;
}
