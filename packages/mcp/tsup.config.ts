import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/browser.ts', 'src/refs.ts', 'src/logger.ts'],
  format: ['esm'],
  outDir: 'dist',
  outExtension: () => ({ js: '.mjs' }),
  target: 'es2022',
  splitting: false,
  sourcemap: true,
  clean: true,
  // The MCP server, refs, browser, and logger modules are all node-only;
  // bundle nothing from node_modules — we want to keep the published package
  // small and rely on the consumer's installed deps (zod, pngjs, mcp sdk).
  external: ['@modelcontextprotocol/sdk', 'zod', 'pngjs'],
});
