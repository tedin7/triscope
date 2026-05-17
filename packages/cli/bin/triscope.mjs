#!/usr/bin/env node
// Triscope CLI entry. Pure ESM JS — no build step.
import { runDev } from '../src/dev.mjs';
import { runState } from '../src/state.mjs';
import { runList } from '../src/list.mjs';
import { runSmoke } from '../src/smoke.mjs';
import { runMcp } from '../src/mcp.mjs';
import { runAutoCapture } from '../src/auto-capture.mjs';
import { runInit } from '../src/init.mjs';

const [, , subcommand, ...rest] = process.argv;

const HELP = `triscope — multi-angle 3D iteration framework

USAGE
  triscope <command> [options]

COMMANDS
  init <dir> [--install]    Scaffold a new triscope project in <dir>. Wraps
                            create-triscope. With --install, also runs
                            \`npm install\` in the new directory.
  dev                       Start the Vite dev server (in the current project).
  state [<jq.path>]         Read /tmp/<project>-state.json. With a path
                            (e.g. ".elements.ship.triangles"), prints just
                            that slice.
  list                      Print the current scene manifest (elements,
                            cameras, knobs) from the running dev server.
  smoke [<element>]         Run the headed-Chromium smoke harness against a
                            lab page. Defaults to the scene lab. Element
                            argument picks /labs/<element>.html.
  mcp install [--project]   Register the triscope MCP server with Claude Code
                            (user scope by default; --project writes .mcp.json
                            in the cwd).
  mcp uninstall             Remove the triscope MCP registration.
  auto-capture [--file <p>] Print one-line motion summary from telemetry.
                            Designed to wire as a Claude Code PostToolUse hook.

OPTIONS
  --url <url>               Override the dev server URL (default http://localhost:5173).
  --port <n>                Override the Vite port for \`triscope dev\`.
  --help, -h                Print this message.

EXAMPLES
  triscope dev
  triscope state .perf.fps
  triscope state .elements.ship
  triscope list
  triscope smoke ship
  triscope smoke --url http://localhost:5174/labs/scene.html
`;

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--project') flags.project = true;
    else if (a === '--no-hook') flags['no-hook'] = true;
    else if (a === '--url') flags.url = argv[++i];
    else if (a === '--file') flags.file = argv[++i];
    else if (a === '--port') flags.port = argv[++i];
    else if (a === '--screenshot') flags.screenshot = argv[++i];
    else if (a === '--install') flags.install = true;
    else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
    else positional.push(a);
  }
  return { flags, positional };
}

async function main() {
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(HELP);
    return;
  }
  const { flags, positional } = parseFlags(rest);
  if (flags.help) {
    console.log(HELP);
    return;
  }
  try {
    switch (subcommand) {
      case 'init':
        await runInit({ dir: positional[0], install: flags.install });
        break;
      case 'dev':
        await runDev({ port: flags.port });
        break;
      case 'state':
        await runState({ path: positional[0] });
        break;
      case 'list':
        await runList({ url: flags.url });
        break;
      case 'smoke':
        await runSmoke({ element: positional[0], url: flags.url, screenshot: flags.screenshot });
        break;
      case 'mcp':
        await runMcp({
          action: positional[0],
          scope: flags.project ? 'project' : 'user',
          url: flags.url,
          withHook: flags['no-hook'] !== true,
        });
        break;
      case 'auto-capture':
        await runAutoCapture({ file: flags.file });
        break;
      default:
        console.error(`Unknown command: ${subcommand}\n`);
        console.log(HELP);
        process.exit(2);
    }
  } catch (err) {
    console.error(`triscope ${subcommand} failed:`, err?.message || err);
    process.exit(1);
  }
}

main();
