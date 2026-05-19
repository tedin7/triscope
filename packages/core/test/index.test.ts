import { describe, expect, it } from 'vitest';

/**
 * The barrel exports must not just *be* functions — they must be the
 * actual implementations. We assert observable behaviour against the
 * re-exports so a wrong wire-up (importing the wrong module, exporting
 * a stub, name collision) would fail here.
 */
describe('@triscope/core barrel (src/index.ts)', () => {
  it('knobDefault — re-exported from types and returns the documented values', async () => {
    const { knobDefault } = await import('../src/index.js');
    expect(knobDefault({ type: 'number', min: 0, max: 1, default: 0.7 })).toBe(0.7);
    expect(knobDefault({ type: 'trigger' })).toBe(false);
  });

  it('composeElements — actually composes (camera namespacing) when called via the barrel', async () => {
    const { composeElements } = await import('../src/index.js');
    const fake = (name: string) => ({
      name,
      cameras: { default: { position: [0, 0, 1], target: [0, 0, 0] } as const },
      knobs: {},
      mount: () => ({ root: { isObject3D: true, children: [] } as any, dispose: () => {} }),
    });
    const composite = composeElements([fake('a'), fake('b')] as any);
    expect(Object.keys(composite.cameras)).toEqual(['a.default', 'b.default']);
  });

  it('mountEditor — re-exported and reaches the DOM when used via the barrel', async () => {
    const { mountEditor } = await import('../src/index.js');
    // Need jsdom; bring it up only for this test so the rest of this file
    // stays node-env.
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><body></body>');
    const container = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(container);
    // mountEditor reaches for the global `document` indirectly via the
    // container's ownerDocument — provide the global too.
    const origDoc = (globalThis as any).document;
    (globalThis as any).document = dom.window.document;
    try {
      mountEditor(container, { g: { type: 'number', min: 0, max: 1, default: 0.5 } }, {}, () => {});
      expect(container.querySelectorAll('input').length).toBe(1);
    } finally {
      (globalThis as any).document = origDoc;
    }
  });

  it('mountLabDom — re-exported and builds the standard ids when run against jsdom', async () => {
    const { mountLabDom } = await import('../src/index.js');
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
    const origDoc = (globalThis as any).document;
    (globalThis as any).document = dom.window.document;
    try {
      const refs = mountLabDom();
      expect(refs.canvas.tagName).toBe('CANVAS');
      expect(refs.boot.id).toBe('boot');
      expect(refs.hud.id).toBe('hud');
      expect(refs.editorContainer.id).toBe('lab-controls');
    } finally {
      (globalThis as any).document = origDoc;
    }
  });

  it('LAB_CSS — non-trivial string with the editor selectors used by the harness', async () => {
    const { LAB_CSS } = await import('../src/index.js');
    expect(LAB_CSS.length).toBeGreaterThan(200);
    expect(LAB_CSS).toContain('.triscope-editor__row');
    expect(LAB_CSS).toContain('#lab-controls');
  });

  it('installSourceTagPatch — re-exported and is idempotent across barrel calls', async () => {
    const { installSourceTagPatch } = await import('../src/index.js');
    installSourceTagPatch(); // ensure patched
    expect(installSourceTagPatch()).toBe(false);
  });

  it("runLab — re-exported as a function (harness lives behind the import; we don't boot WebGPU here)", async () => {
    const { runLab } = await import('../src/index.js');
    expect(typeof runLab).toBe('function');
    expect(runLab.length).toBeGreaterThanOrEqual(1); // takes a LabOptions arg
  });
});

describe('@triscope/core vite entry (src/vite.ts)', () => {
  it('triscopeTelemetryPlugin — returns a Vite plugin shape (name + configureServer)', async () => {
    const { triscopeTelemetryPlugin } = await import('../src/vite.js');
    const plugin = triscopeTelemetryPlugin({ project: 'barrel-test' });
    expect(typeof plugin.name).toBe('string');
    expect(typeof plugin.configureServer).toBe('function');
    expect(typeof plugin.handleHotUpdate).toBe('function');
  });

  it('resolveTelemetryPaths — returns paths derived from cwd/tmpdir, not random strings', async () => {
    const { resolveTelemetryPaths } = await import('../src/vite.js');
    const out = resolveTelemetryPaths(process.cwd());
    expect(typeof out.statePath).toBe('string');
    expect(out.statePath).toMatch(/-state\.json$/);
    expect(out.logPath).toMatch(/-state\.log$/);
  });
});
