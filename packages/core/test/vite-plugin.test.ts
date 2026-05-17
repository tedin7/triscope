import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { triscopeTelemetryPlugin } from '../src/telemetry.js';

type MwHandler = (req: any, res: any, next?: () => void) => unknown | Promise<unknown>;

interface MwServer {
  middlewares: { use: (path: string, handler: MwHandler) => void };
  ws: { send: (msg: unknown) => void };
}

function makeServer(): { server: MwServer; routes: Map<string, MwHandler>; wsMessages: unknown[] } {
  const routes = new Map<string, MwHandler>();
  const wsMessages: unknown[] = [];
  const server: MwServer = {
    middlewares: { use: (path, handler) => routes.set(path, handler) },
    ws: { send: (msg) => wsMessages.push(msg) },
  };
  return { server, routes, wsMessages };
}

function fakeReq(method: string, url: string, body?: string): Readable & { method: string; url: string } {
  const stream = body !== undefined ? Readable.from([body]) : Readable.from([]);
  (stream as any).method = method;
  (stream as any).url = url;
  return stream as any;
}

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function fakeRes(): { res: any; captured: CapturedResponse; done: Promise<void> } {
  const captured: CapturedResponse = { statusCode: 200, headers: {}, body: '' };
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });
  const res = {
    statusCode: 200,
    setHeader(k: string, v: string) { captured.headers[k.toLowerCase()] = v; },
    end(chunk?: string | Buffer) {
      captured.statusCode = this.statusCode;
      if (chunk !== undefined) captured.body = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      resolveDone();
    },
  };
  return { res, captured, done };
}

async function call(handler: MwHandler, req: any, res: any, captured: CapturedResponse, done: Promise<void>): Promise<CapturedResponse> {
  await Promise.resolve(handler(req, res, () => done /* no-op next */));
  await done;
  return captured;
}

const TEST_PROJECT = `triscope-test-vite-${process.pid}`;
const STATE_PATH = join(tmpdir(), `${TEST_PROJECT}-state.json`);
const LOG_PATH = join(tmpdir(), `${TEST_PROJECT}-state.log`);

function cleanupFiles() {
  for (const p of [STATE_PATH, LOG_PATH]) {
    try { rmSync(p, { force: true }); } catch {}
  }
}

describe('triscopeTelemetryPlugin', () => {
  beforeEach(cleanupFiles);
  afterEach(cleanupFiles);

  it('registers /__state, /__knob, /__manifest middleware', () => {
    const plugin = triscopeTelemetryPlugin({ project: TEST_PROJECT });
    const { server, routes } = makeServer();
    plugin.configureServer!.call(plugin, server as any);
    expect([...routes.keys()].sort()).toEqual(['/__knob', '/__manifest', '/__state']);
  });

  it('POST /__state writes JSON file and appends to log', async () => {
    const plugin = triscopeTelemetryPlugin({ project: TEST_PROJECT });
    const { server, routes } = makeServer();
    plugin.configureServer!.call(plugin, server as any);
    const handler = routes.get('/__state')!;
    const payload = { project: TEST_PROJECT, perf: { fps: 60 }, knobs: {} };
    const { res, captured, done } = fakeRes();
    await call(handler, fakeReq('POST', '/__state', JSON.stringify(payload)), res, captured, done);
    expect(captured.statusCode).toBe(200);
    expect(existsSync(STATE_PATH)).toBe(true);
    const saved = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    expect(saved.perf.fps).toBe(60);
  });

  it('GET /__state returns the last POSTed payload', async () => {
    const plugin = triscopeTelemetryPlugin({ project: TEST_PROJECT });
    const { server, routes } = makeServer();
    plugin.configureServer!.call(plugin, server as any);
    const handler = routes.get('/__state')!;
    // POST first
    const post = fakeRes();
    await call(handler, fakeReq('POST', '/__state', JSON.stringify({ time: 1.5 })), post.res, post.captured, post.done);
    // GET back
    const get = fakeRes();
    await call(handler, fakeReq('GET', '/__state'), get.res, get.captured, get.done);
    expect(JSON.parse(get.captured.body).time).toBe(1.5);
  });

  it('POST /__knob then GET /__knob drains the queue once', async () => {
    const plugin = triscopeTelemetryPlugin({ project: TEST_PROJECT });
    const { server, routes } = makeServer();
    plugin.configureServer!.call(plugin, server as any);
    const handler = routes.get('/__knob')!;
    // Push 2 knob updates.
    const post = fakeRes();
    await call(handler, fakeReq('POST', '/__knob', JSON.stringify([
      { element: 'ship', key: 'wind', value: 1.5 },
      { element: 'ship', key: 'yaw', value: 0.3 },
    ])), post.res, post.captured, post.done);
    // First GET drains.
    const get1 = fakeRes();
    await call(handler, fakeReq('GET', '/__knob'), get1.res, get1.captured, get1.done);
    const drained = JSON.parse(get1.captured.body);
    expect(drained).toHaveLength(2);
    expect(drained[0].key).toBe('wind');
    // Second GET is empty.
    const get2 = fakeRes();
    await call(handler, fakeReq('GET', '/__knob'), get2.res, get2.captured, get2.done);
    expect(JSON.parse(get2.captured.body)).toEqual([]);
  });

  it('GET /__knob/current returns persisted state per element', async () => {
    const plugin = triscopeTelemetryPlugin({ project: TEST_PROJECT });
    const { server, routes } = makeServer();
    plugin.configureServer!.call(plugin, server as any);
    const handler = routes.get('/__knob')!;
    // Push some knobs.
    const post = fakeRes();
    await call(handler, fakeReq('POST', '/__knob', JSON.stringify([
      { element: 'ship', key: 'wind', value: 1.5 },
      { element: 'water', key: 'depth', value: 100 },
    ])), post.res, post.captured, post.done);
    // current state survives draining.
    const drain = fakeRes();
    await call(handler, fakeReq('GET', '/__knob'), drain.res, drain.captured, drain.done);
    const cur = fakeRes();
    await call(handler, fakeReq('GET', '/current'), cur.res, cur.captured, cur.done);
    const persisted = JSON.parse(cur.captured.body);
    expect(persisted.ship.wind).toBe(1.5);
    expect(persisted.water.depth).toBe(100);
  });

  it('seeds manifest from package.json#triscope.labs', async () => {
    // Create a fake project dir with package.json declaring labs.
    const cwd = join(tmpdir(), `${TEST_PROJECT}-pkg`);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      name: TEST_PROJECT,
      triscope: { labs: { ship: '/ship.html', water: '/water.html' } },
    }));
    const origCwd = process.cwd();
    process.chdir(cwd);
    try {
      const plugin = triscopeTelemetryPlugin({ project: TEST_PROJECT });
      const { server, routes } = makeServer();
      plugin.configureServer!.call(plugin, server as any);
      const handler = routes.get('/__manifest')!;
      const get = fakeRes();
      await call(handler, fakeReq('GET', '/__manifest'), get.res, get.captured, get.done);
      const manifest = JSON.parse(get.captured.body);
      expect(manifest.elements.ship.labUrl).toBe('/ship.html');
      expect(manifest.elements.water.labUrl).toBe('/water.html');
    } finally {
      process.chdir(origCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('POST /__manifest from a live harness overrides the seed', async () => {
    const plugin = triscopeTelemetryPlugin({ project: TEST_PROJECT });
    const { server, routes } = makeServer();
    plugin.configureServer!.call(plugin, server as any);
    const handler = routes.get('/__manifest')!;
    // Harness POSTs its real manifest.
    const post = fakeRes();
    await call(handler, fakeReq('POST', '/__manifest', JSON.stringify({
      element: 'ship',
      labUrl: '/triscope-ship.html',
      cameras: [{ name: 'bow' }, { name: 'stern' }],
      knobs: [{ name: 'wind', current: 0.6 }],
    })), post.res, post.captured, post.done);
    const get = fakeRes();
    await call(handler, fakeReq('GET', '/__manifest'), get.res, get.captured, get.done);
    const manifest = JSON.parse(get.captured.body);
    expect(manifest.elements.ship.cameras).toHaveLength(2);
    expect(manifest.elements.ship.knobs[0].current).toBe(0.6);
  });

  it('handleHotUpdate triggers full-reload for shader/element files', () => {
    const plugin = triscopeTelemetryPlugin({ project: TEST_PROJECT });
    const { server, wsMessages } = makeServer();
    const result = plugin.handleHotUpdate!.call(plugin, {
      file: '/some/path/ShipElement.ts',
      server: server as any,
    } as any);
    expect(result).toEqual([]);
    expect(wsMessages).toEqual([{ type: 'full-reload' }]);
  });

  it('handleHotUpdate is a no-op for unrelated files', () => {
    const plugin = triscopeTelemetryPlugin({ project: TEST_PROJECT });
    const { server, wsMessages } = makeServer();
    const result = plugin.handleHotUpdate!.call(plugin, {
      file: '/some/path/main.css',
      server: server as any,
    } as any);
    expect(result).toBeUndefined();
    expect(wsMessages).toEqual([]);
  });
});
