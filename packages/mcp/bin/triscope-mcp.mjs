#!/usr/bin/env node
// Triscope MCP server entry. Stdio JSON-RPC.
// Imports the tsup-built ESM bundle so we ship a single dist artifact and
// don't have to keep src/ in published tarballs for runtime.
import { startServer } from '../dist/server.mjs';
startServer().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[triscope-mcp] fatal:', err);
  process.exit(1);
});
