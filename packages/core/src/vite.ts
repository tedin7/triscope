// Node-only entry. Vite plugin + helpers that touch the filesystem.
// Import this from your `vite.config.{js,ts}`, never from browser code.
export { triscopeTelemetryPlugin, resolveTelemetryPaths } from './telemetry.js';
export type { TelemetryPaths } from './telemetry.js';
