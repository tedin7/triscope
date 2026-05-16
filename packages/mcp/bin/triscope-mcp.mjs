#!/usr/bin/env node
// Triscope MCP server entry. Stdio JSON-RPC.
import { startServer } from '../src/server.mjs';
startServer().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[triscope-mcp] fatal:', err);
  process.exit(1);
});
