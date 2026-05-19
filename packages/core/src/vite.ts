// Node-only entry. Vite plugin + helpers that touch the filesystem.
// Import this from your `vite.config.{js,ts}`, never from browser code.

export type { TelemetryPaths } from './telemetry.js';
export { resolveTelemetryPaths, triscopeTelemetryPlugin } from './telemetry.js';
