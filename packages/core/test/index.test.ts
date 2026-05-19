import { describe, expect, it } from 'vitest';

describe('@triscope/core/src/index.ts', () => {
  it('re-exports the public surface without throwing on import', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.knobDefault).toBe('function');
    expect(typeof mod.installSourceTagPatch).toBe('function');
    expect(typeof mod.composeElements).toBe('function');
    expect(typeof mod.mountEditor).toBe('function');
    expect(typeof mod.mountLabDom).toBe('function');
    expect(typeof mod.LAB_CSS).toBe('string');
    expect(typeof mod.runLab).toBe('function');
  });
});

describe('@triscope/core/src/vite.ts', () => {
  it('re-exports the telemetry plugin + path helpers', async () => {
    const mod = await import('../src/vite.js');
    expect(typeof mod.triscopeTelemetryPlugin).toBe('function');
    expect(typeof mod.resolveTelemetryPaths).toBe('function');
  });
});
