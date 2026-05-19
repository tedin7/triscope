import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      include: ['src/**'],
      // harness.ts is the WebGPU lab runner — it needs a real renderer
      // and is exercised by `triscope smoke` end-to-end. Phase-1 covers
      // the rest of core fully; the rendered grid + RAF loop are left
      // to the headed-Chromium smoke harness. The .d.ts shim has no
      // executable code.
      exclude: [
        'src/harness.ts',
        'src/three-webgpu-shim.d.ts',
      ],
    },
  },
});
