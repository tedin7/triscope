import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      include: ['src/**'],
      // server.ts and browser.ts (full pool) are the MCP stdio entrypoint
      // and the Chromium/CDP driver — both need real subprocess + I/O.
      // Phase-2 covers their pure helpers via unit tests; the live flow
      // is exercised by the smoke job in CI against a running dev server.
      // Nothing is excluded here so the report shows what's *not* yet
      // unit-tested in those files.
    },
  },
});
