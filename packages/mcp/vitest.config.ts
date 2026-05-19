import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      include: ['src/**'],
      // server.ts and browser.ts (full pool) are the MCP stdio entrypoint
      // and the Chromium/CDP driver — both need real subprocess + I/O.
      // Phase-1 covers their pure helpers only; the live flow is tested
      // by `triscope smoke` end-to-end against a running dev server.
      exclude: [
        'src/server.ts',
      ],
    },
  },
});
