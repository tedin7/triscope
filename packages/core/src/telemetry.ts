import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Plugin } from 'vite';

interface TelemetryOptions {
  /**
   * Project name used to namespace state files in /tmp.
   * Defaults to the name in package.json (sanitized).
   */
  project?: string;
  /** Override state file path. */
  statePath?: string;
  /** Override log file path. */
  logPath?: string;
  /**
   * Regex matching files that need a full-reload (instead of HMR) when they
   * change. Default catches TSL material / mesh / element / shader sources,
   * because vite HMR cannot remount a THREE.Material already in the scene.
   * Pass `null` to disable.
   */
  forceReloadOn?: RegExp | null;
}

function readProjectLabs(cwd: string): Record<string, string> {
  try {
    const p = join(cwd, 'package.json');
    if (!existsSync(p)) return {};
    const pkg = JSON.parse(readFileSync(p, 'utf8'));
    const labs = pkg?.triscope?.labs;
    if (labs && typeof labs === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(labs)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

function readPackageName(cwd: string): string {
  try {
    const p = join(cwd, 'package.json');
    if (!existsSync(p)) return 'triscope-project';
    const pkg = JSON.parse(readFileSync(p, 'utf8'));
    return String(pkg.name ?? 'triscope-project').replace(/[^A-Za-z0-9._-]/g, '-');
  } catch {
    return 'triscope-project';
  }
}

/**
 * Vite plugin that wires the telemetry sink:
 *
 *   POST /__state    → writes /tmp/<project>-state.json + appends to /tmp/<project>-state.log
 *   GET  /__state    → returns the latest snapshot
 *   POST /__knob     → stores a pending knob change for the harness to consume
 *   GET  /__knob     → returns and CLEARS the pending knob queue (polled by harness)
 *   GET  /__manifest → returns the registered element manifest (POSTed by harness on boot)
 *   POST /__manifest → harness pushes the live manifest (elements/cameras/knobs)
 *
 * The names start with __ so they cannot collide with user routes.
 */
export function triscopeTelemetryPlugin(opts: TelemetryOptions = {}): Plugin {
  const project = opts.project ?? readPackageName(process.cwd());
  const statePath = opts.statePath ?? join(tmpdir(), `${project}-state.json`);
  const logPath = opts.logPath ?? join(tmpdir(), `${project}-state.log`);

  // In-memory pending knob queue. Harness polls and drains.
  const pendingKnobs: Array<{ element: string; key: string; value: unknown }> = [];
  // Manifest is a map keyed by element name so multiple labs can co-exist —
  // each harness POSTs its own entry on boot.
  const manifestByElement: Record<string, unknown> = {};
  // Pre-seed with package.json#triscope.labs so MCP capture_views works on
  // the very first call (before any browser tab loads a lab).
  for (const [name, labUrl] of Object.entries(readProjectLabs(process.cwd()))) {
    manifestByElement[name] = { element: name, labUrl };
  }
  const forceReloadOn =
    opts.forceReloadOn === null
      ? null
      : opts.forceReloadOn ?? /(\.tsl|Element|Mesh|Material|Shader)\.(ts|tsx|js|mjs)$/i;

  return {
    name: 'triscope-telemetry',
    configureServer(server) {
      mkdirSync(dirname(statePath), { recursive: true });

      const readBody = (req: any): Promise<string> =>
        new Promise((resolve, reject) => {
          let body = '';
          req.on('data', (c: Buffer) => (body += c));
          req.on('end', () => resolve(body));
          req.on('error', reject);
        });

      server.middlewares.use('/__state', async (req, res, next) => {
        if (!req.method) return next();
        try {
          if (req.method === 'POST') {
            const body = await readBody(req);
            const payload = JSON.parse(body);
            writeFileSync(statePath, JSON.stringify(payload, null, 2));
            const ts = new Date().toISOString();
            const fps = (payload?.perf?.fps as number | undefined)?.toFixed?.(0) ?? '?';
            const cam = (payload?.activeCamera as string | undefined) ?? '?';
            appendFileSync(logPath, `${ts} fps=${fps} cam=${cam}\n`);
            res.statusCode = 200;
            return res.end('ok');
          }
          if (req.method === 'GET') {
            res.setHeader('content-type', 'application/json');
            return res.end(existsSync(statePath) ? readFileSync(statePath) : '{}');
          }
        } catch (err) {
          res.statusCode = 400;
          return res.end(String(err));
        }
        return next();
      });

      server.middlewares.use('/__knob', async (req, res, next) => {
        if (!req.method) return next();
        try {
          if (req.method === 'POST') {
            const body = await readBody(req);
            const payload = JSON.parse(body);
            if (Array.isArray(payload)) pendingKnobs.push(...payload);
            else pendingKnobs.push(payload);
            res.statusCode = 200;
            return res.end('ok');
          }
          if (req.method === 'GET') {
            res.setHeader('content-type', 'application/json');
            const drained = pendingKnobs.splice(0, pendingKnobs.length);
            return res.end(JSON.stringify(drained));
          }
        } catch (err) {
          res.statusCode = 400;
          return res.end(String(err));
        }
        return next();
      });

      server.middlewares.use('/__manifest', async (req, res, next) => {
        if (!req.method) return next();
        try {
          if (req.method === 'POST') {
            const body = await readBody(req);
            const payload = JSON.parse(body) as { element?: string } & Record<string, unknown>;
            if (payload?.element && typeof payload.element === 'string') {
              manifestByElement[payload.element] = payload;
            }
            res.statusCode = 200;
            return res.end('ok');
          }
          if (req.method === 'GET') {
            res.setHeader('content-type', 'application/json');
            return res.end(JSON.stringify({ elements: manifestByElement }));
          }
        } catch (err) {
          res.statusCode = 400;
          return res.end(String(err));
        }
        return next();
      });
    },
    handleHotUpdate({ file, server }) {
      // TSL materials (and any code that ends up baked into the renderer
      // node graph) cannot be remounted via vite HMR because the THREE
      // Material instance is already in the scene. Force full-reload so
      // edits to shader/element/mesh files reach the renderer. All other
      // files (plain ts/css/etc.) continue to HMR normally.
      if (forceReloadOn && forceReloadOn.test(file)) {
        server.ws.send({ type: 'full-reload' });
        return [];
      }
      return undefined;
    },
  };
}

export interface TelemetryPaths {
  project: string;
  statePath: string;
  logPath: string;
}

export function resolveTelemetryPaths(cwd: string = process.cwd()): TelemetryPaths {
  const project = readPackageName(cwd);
  return {
    project,
    statePath: join(tmpdir(), `${project}-state.json`),
    logPath: join(tmpdir(), `${project}-state.log`),
  };
}
