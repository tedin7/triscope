// Browser-safe surface. The Vite plugin lives at `@triscope/core/vite`
// (separate entry because it imports Node `fs`/`os`/`path`).
export type {
  Element,
  CameraSpec,
  Knob,
  MountContext,
  MountHandle,
} from './types.js';
export { knobDefault } from './types.js';

export { runLab } from './harness.js';
export type { LabOptions, LabHandle } from './harness.js';

export { mountEditor } from './editor.js';
