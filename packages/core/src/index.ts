// Browser-safe surface. The Vite plugin lives at `@triscope/core/vite`
// (separate entry because it imports Node `fs`/`os`/`path`).

export type { ComposeOptions } from './compose.js';
export { composeElements } from './compose.js';
export { mountEditor } from './editor.js';
export type { GpuProbeStats, LabHandle, LabOptions } from './harness.js';
export { runLab } from './harness.js';
export type { InspectSelection } from './inspect.js';
export { LAB_CSS } from './lab/css.js';
export type { LabDomRefs } from './lab/dom.js';
export { mountLabDom } from './lab/dom.js';
export type { SourceFrame, SourceTag } from './source-tag.js';
export { installSourceTagPatch } from './source-tag.js';
export type {
  CameraSpec,
  Element,
  Knob,
  MountContext,
  MountHandle,
  TriscopeEvent,
} from './types.js';
export { knobDefault } from './types.js';
