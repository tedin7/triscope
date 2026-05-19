# Triscope

A Three.js + WebGPU element-iteration framework for AI-driven 3D scene
development. Born from the water3d prototype, where Claude and a human
co-iterated on a photoreal ocean by relying on **multi-angle lab grids**,
a **terminal-readable telemetry sink**, a **headed-Chromium smoke test**,
and **project-scoped skills** that taught fresh sessions the rules of the
domain.

Triscope packages that loop so any new Three.js + WebGPU project can adopt
it on day one — and so AI agents (Claude Code, others) have a stable CLI +
MCP surface to drive the iteration.

> **Status**: the core harness (`@triscope/core`) and MCP server
> (`@triscope/mcp`) are used in production by [water3d](https://github.com/tedin7/water3d).
> The unit-test suite covers the Element composer, telemetry plugin,
> motion probes, source-tagger, knob editor, lab DOM, reference-image
> diff (mean-abs + SSIM), CLI helpers, and the project scaffolder —
> 291 tests across all four packages (vitest). A full end-to-end smoke
> (`examples/ocean-galleon`) boots Vite + headed Chromium, validates fps
> + knob propagation + WebGPU-canvas readback, and runs in CI under
> xvfb. Heading for **0.1.0**; see [`ROADMAP`](#roadmap-to-010) below.

## Quickstart

Clone, install, and watch the reference galleon lab in a browser:

```bash
git clone https://github.com/tedin7/triscope.git
cd triscope
npm install
npm run build --workspace=@triscope/core
cd examples/ocean-galleon
npm run dev      # opens at http://127.0.0.1:5173/
```

Move the knob sliders on the right; the 8-camera grid updates live. Knob
state survives full-reload (TSL/material edits that can't HMR get a
forced reload but keep your tuning).

Run the headed-Chromium smoke that exercises the whole stack:

```bash
npm run smoke
# → { ok: true, cameras: 8, baselineFps: ~60, afterFps: ~88,
#     visualDiff: { supported: true, changedCameras: 6 } }
```

## The shape

```
triscope/
├── packages/
│   ├── core/                @triscope/core      runtime: Element contract,
│   │                                            multi-camera lab harness,
│   │                                            Vite telemetry plugin
│   ├── cli/                 @triscope/cli       `triscope` binary
│   ├── mcp/                 @triscope/mcp       MCP server for live AI control
│   └── create-triscope/     npm init triscope   scaffolder (WIP)
├── examples/
│   └── ocean-galleon/       runnable reference lab
└── docs/                    design + recipes
```

## The iteration loop

```
  Human / AI edits  src/element.ts             ("drop windPressure 1.6 → 0.6")
     │
     ▼  Vite HMR (or full-reload for TSL materials)
  browser remounts the element in the lab grid (N cameras)
     │
     ▼  every 500 ms
  telemetry POST /__state ─► /tmp/<proj>-state.json
     │
     ▼  AI calls (CLI or MCP)
  triscope state .elements.ship                     numeric state
  mcp__triscope__set_knob ship windPressure 1.6     live knob
  mcp__triscope__capture_views ship                 N-angle PNGs in one call
  mcp__triscope__diff_reference ship deck-close     vs stored reference photo
     │
     ▼  AI judges per-camera, edits, repeats
  triscope smoke ship                               CI/sign-off gate
```

## Element contract

The whole framework hangs off one TypeScript interface
([`packages/core/src/types.ts`](./packages/core/src/types.ts)):

```ts
import type { Element } from '@triscope/core';
import * as THREE from 'three/webgpu';

export const ship: Element = {
  name: 'ship',
  mount: ({ parent, ctx }) => { /* add meshes, return { root, dispose, userData } */ },
  bounds: { min: [-15, -3, -4], max: [15, 12, 4] },
  cameras: {
    bow:  { position: [25, 6, 0], target: [0, 4, 0] },
    stern:{ position: [-25, 6, 0], target: [0, 4, 0] },
    // 6+ more — each becomes one pane in the lab grid
  },
  knobs: {
    windPressure: { type: 'number', min: 0, max: 2, default: 0.6 },
    sailColor:    { type: 'color', default: '#d8c89a' },
  },
  onKnob: (handle, key, value) => { /* live uniform / state update */ },
  telemetry: (handle, ctx) => ({ triangles: handle.userData.triCount }),
  motionProbes: {
    // sampled every frame into a 120-pt ring buffer; harness publishes
    // peakToPeak / dominantFreqHz / latest under telemetry.elements.<name>.motion
    sailFlutter: (handle, ctx) =>
      handle.userData.uWindPressure.value * Math.sin(ctx.time.value * 4.3),
  },
};
```

Composition is just an element that mounts other elements. Same contract
everywhere.

## `window.__TRISCOPE__` (browser global)

The harness publishes this once `runLab()` resolves. CDP-driven tools and
in-page console scripts use it as the single entry point.

| Member | Type | Notes |
|---|---|---|
| `cameras` | `Record<string, THREE.PerspectiveCamera>` | All Element-declared cameras, by name |
| `knobValues` | `Record<string, number \| string \| boolean>` | Live knob state, mirrors `/__knob/current` |
| `setKnob(key, value)` | `void` | Apply a knob change in-page (also flows to the editor UI) |
| `sampleTelemetry()` | `Record<string, unknown>` | Same payload as `POST /__state`, on demand |
| `captureViews()` | `Promise<Record<string, base64PNG>>` | One PNG per camera, full-canvas render. **Only viable WebGPU readback path** — `canvas.toDataURL` and `Page.captureScreenshot` both miss the surface (gpuweb/gpuweb#1781). |
| `captureMotionFrames(cam, { frames, dt, mode })` | `Promise<base64PNG[]>` | `mode='time'` pauses RAF and steps time forward deterministically (byte-identical re-captures); `mode='real'` samples at wall-clock dt |

## MCP integration (for Claude Code & friends)

**Claude Code** (per project):

```bash
cd <your-triscope-project>
npx triscope mcp install            # adds .mcp.json
```

**Codex CLI** (separate ecosystem, manual registration):

```bash
codex mcp add triscope \
  -- node $(npm root)/@triscope/mcp/bin/triscope-mcp-supervised.mjs
```

(Edit `~/.codex/config.toml` directly if you prefer. The supervised
wrapper auto-restarts the server on crash and is recommended for both
ecosystems.)

The MCP server exposes:

| Tool | Purpose |
|---|---|
| `list_elements` / `read_telemetry` / `health` | introspection |
| `set_knob` | live knob updates (single or batched) |
| `capture_views` / `capture_motion` | per-camera PNGs or motion filmstrips |
| `set_reference[_motion]` / `diff_reference[_motion]` | reference images + perceptual diff (meanAbsDiff + SSIM) |
| `auto_tune` | golden-section knob convergence on SSIM vs reference |
| `inspect` / `open_selection` | flip the running lab into solo+OrbitControls inspect mode; click a mesh, then `open_selection` jumps your editor to that file:line |
| `snapshot` / `restore` / `list_snapshots` | freeze HEAD commit + knob values as a git tag; restore later via checkout + knob replay |
| `run_smoke` | CI gate; runs the headed-Chromium harness |

All talk to the running dev server (`http://localhost:5173`) and a
persistent Chromium pool.

See [`packages/mcp/README.md`](./packages/mcp/README.md) for tool schemas.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `captureViews()` returns 300×150 PNGs | canvas never resized | Call after first `resize()` tick (harness handles it; smoke waits for `fps > 1` telemetry) |
| Two consecutive `Page.captureScreenshot` byte-identical | WebGPU surface lives outside the page compositor | Use `__TRISCOPE__.captureViews()` instead |
| `WebGPU Device Lost: Device was destroyed` at teardown | Chrome / vite torn down by smoke `finally` | Cosmetic, ignore |
| `boot failed: navigator.gpu is unavailable` | Headless Chrome without Vulkan flags | Run headed under xvfb (see `examples/ocean-galleon/smoke.mjs`) |
| Smoke `fps: 0` baseline | Reading state file before harness wrote first tick | Wait for `fps > 1` in a poll loop (smoke does this) |
| Vite "Port 5173 in use" in smoke | Another dev server already running | The smoke uses a random port 5300-5400 with `--strictPort` |
| MCP using wrong Chromium binary | `CHROME_BIN` env only read at MCP server startup | Restart the MCP server after changing `CHROME_BIN` / `PUPPETEER_EXECUTABLE_PATH`. Resolution: explicit arg → `CHROME_BIN` → `PUPPETEER_EXECUTABLE_PATH` → plain `chromium`. |
| `capture_views` returns `Connection closed` on big elements | inline payload exceeded ~1 MB MCP message budget and crashed the server | Already auto-capped (default `inline=false`). Override budget via `TRISCOPE_INLINE_PAYLOAD_BUDGET=2097152` if you really need more inline content. |
| `DevTools endpoint did not become ready on 127.0.0.1:9230` from `inspect`/`capture_views` | Sandboxed Chromium can't bind a network port, OR another Chromium instance is reusing the same profile dir (silent forward on singleton match). | Pre-launch Chrome yourself: `chromium --remote-debugging-port=9230 --enable-unsafe-webgpu http://localhost:5173/`. The MCP server auto-attaches to any existing DevTools endpoint on that port before trying to spawn its own. Or set `TRISCOPE_DEBUG_PORT` to a port your sandbox allows. |

## Platform support

**Linux**: primary target — everything is tested here (Wayland + X11
sessions, both work with the X11 ozone flag on Wayland).

**macOS**: should work — Node + Three + Vite + Chrome are all
first-class on darwin. `defaultChromeBinary()` returns the standard
`/Applications/Google Chrome.app` path; override with `CHROME_BIN` if
you use Chrome Canary or Chromium directly.

**Windows**: lightly supported, NOT regularly tested. Known gotchas:
- `CHROME_BIN` defaults to `C:\Program Files\Google\Chrome\Application\chrome.exe`
  on Win32; set the env var explicitly if Chrome lives elsewhere (Edge,
  Brave, custom install path).
- `npm`, `git`, `code` are `.cmd` scripts on Windows; we set
  `shell: true` on spawn for those, so they resolve correctly.
- The ocean-galleon smoke uses `pkill` for cleanup (Linux-only) and the
  CI workflow assumes `xvfb` (also Linux-only). The smoke as written
  will fail on Windows. PRs welcome.
- TSL/WebGPU edits trigger a Vite force-reload that may print a path
  with backslashes; the matching is case-insensitive and tolerates
  both separators, so this is cosmetic.

If you run into a Windows-only failure, please open an issue with the
exact MCP tool call + Node error message — most fixes will be small.

## Roadmap to 0.1.0

- [x] `@triscope/core` Element contract + harness + Vite plugin
- [x] `@triscope/mcp` capture/diff/knob/telemetry tools + supervisor + health
- [x] vitest suite — 291 tests across core/cli/mcp/create-triscope:
      Element composer, telemetry plugin, motion probes, source-tagger,
      knob editor, lab DOM, reference-image diff (mean-abs + SSIM),
      MCP logger + browser pool helpers, MCP server pure helpers
      (project name, jq path, lab map, absolutize, recordError ring,
      probeStatsFromPng Rec.709, jsonResult), CLI commands (state/
      list/auto-capture/init/mcp), `parse-flags`, project scaffolder
- [x] `examples/ocean-galleon` runnable from a fresh clone
- [x] `triscope init` (wired to `create-triscope`)
- [x] `@triscope/mcp` ported to TypeScript with zod-validated tool args
- [x] GPU readback probes (luminance, dynamic range) on captures + server fallback
- [x] Inline payload safety cap (no more OOM on large captures)
- [x] Per-element telemetry merge (multi-lab without state clobbering)
- [x] Structured logger + CHROME_BIN env propagation
- [x] **Inspect mode** — auto source-tag on `Object3D.add` + URL `?inspect=<el>` + OrbitControls + click-to-pick + hover highlight + cross-reload persistence
- [x] **`mcp__triscope__inspect` + `mcp__triscope__open_selection`** — chat-native inspect loop, jumps editor to file:line
- [x] **SSIM perceptual diff** (alongside meanAbsDiff)
- [x] **`mcp__triscope__auto_tune`** — golden-section knob convergence on SSIM vs reference
- [x] **Snapshot/restore via git tags** (per [`docs/design.md`](./docs/design.md))
- [x] **`composeElements`** — multi-element labs with namespaced cameras/knobs/probes
- [x] CI revival — `.github/workflows/ci.yml`: typecheck + unit tests
      with coverage on every PR, and the `ocean-galleon` smoke under
      `xvfb` against a real Chromium build
- [x] npm publish pipeline — `.github/workflows/release.yml` triggers
      on `v*.*.*` tags, re-runs the full CI gate against the tag
      commit, verifies every workspace's `package.json#version`
      matches the tag, then runs `npm publish --workspaces` with
      provenance. CHANGELOG + CONTRIBUTING in place. Tag a release
      to publish (a maintainer's gesture, not on every merge).

## License

MIT
