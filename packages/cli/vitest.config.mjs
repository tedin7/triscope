import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.mjs'],
    environment: 'node',
    coverage: {
      include: ['src/**', 'bin/**'],
      // Phase-1 scope: pure logic. The following are end-to-end runners
      // exercised by `triscope smoke` against real Chromium / vite, not
      // by unit tests, so excluding them gives an honest line-coverage
      // number for what we actually test.
      exclude: [
        'src/dev.mjs', // thin spawn(vite) proxy
        'src/smoke.mjs', // headed-Chromium smoke harness
        'bin/triscope.mjs', // dispatcher: exercised via subprocess in bin.test
      ],
    },
  },
});
