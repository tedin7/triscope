# Changelog

All notable changes to Triscope are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-19

First publishable release. The four published packages
(`@triscope/core`, `@triscope/cli`, `@triscope/mcp`, `create-triscope`)
move from `0.0.0` to `0.1.0` together.

### Added — `@triscope/core`

- **Element contract** with mount/dispose, cameras, knobs, optional
  bounds, `onKnob`, telemetry, motion probes, and discrete events.
- **Multi-camera lab harness** (`runLab`) — auto-grid layout, knob
  editor pane, fps overlay, telemetry sink, knob persistence across
  full reload, motion-probe ring buffer with frequency/peak-to-peak
  stats.
- **`composeElements`** — multi-element labs with namespaced
  cameras/knobs/probes/events. Bounds union, telemetry merge by name.
- **Inspect mode** — `?inspect=<element>` URL activates OrbitControls
  + raycaster picking; clicked mesh writes a structured selection
  (source frame, parent chain, geometry, material colour) into
  `window.__TRISCOPE__.lastSelection`. Persisted across reloads.
- **Auto source-tag** — `Object3D.prototype.add` is monkey-patched
  once per process so every added mesh gets `userData.__tris.source =
  { file, line, col, fn }` from the user's stack frame. Inspect/MCP
  surface this for chat-native debugging.
- **`@triscope/core/vite` plugin** — `/__state`, `/__knob`,
  `/__manifest` middleware + log file + WebSocket-driven full reload
  on Element/shader file changes.
- **`mountLabDom` + `LAB_CSS`** — zero-boilerplate scaffolding for a
  per-Element lab page; idempotent.

### Added — `@triscope/cli`

- `triscope dev` — proxies to a local Vite.
- `triscope state [.jq.path]` — reads the telemetry sink.
- `triscope list` — prints the live manifest from the dev server.
- `triscope smoke [<element>]` — headed-Chromium smoke harness with
  WebGPU enabled, pixel-variance + non-black-ratio thresholds, JSON
  summary.
- `triscope init <dir> [--install]` — wraps `create-triscope`.
- `triscope mcp install|uninstall [--project] [--no-hook]` — wires
  the MCP server + the PostToolUse auto-capture hook into Claude
  Code (user scope by default, `--project` for cwd-local files).
- `triscope auto-capture` — one-line motion summary from telemetry,
  designed as a PostToolUse hook.

### Added — `@triscope/mcp`

- MCP tools: `list_elements`, `read_telemetry`, `set_knob`,
  `capture_views`, `run_smoke`, `inspect`, `open_selection`,
  `set_reference`, `diff_reference`, `set_reference_motion`,
  `diff_reference_motion`, `auto_tune`, `snapshot`, `restore`.
- **SSIM perceptual diff** alongside meanAbsDiff for visual diffs;
  used by `auto_tune` as the convergence objective (golden-section).
- **Persistent Chromium pool** — one CDP-attached browser per MCP
  process, self-healing on external death; navigations are reused.
- **Inline payload safety cap** (`TRISCOPE_INLINE_PAYLOAD_BUDGET`)
  prevents OOM on bulk captures by writing larger payloads to
  /tmp instead of inlining them in the MCP response.
- **Structured logger** with stderr + rotating 1 MB log file.
- **`triscope-mcp-supervised`** wrapper bin.

### Added — `create-triscope`

- `npm init triscope <dir>` scaffolds a project with Vite, TypeScript,
  the lab template, `.claude/skills/`, and example knobs/cameras.
- Literal `__PROJECT_NAME__` substitution in text files only;
  binary files copied verbatim.

### Added — tooling

- **CI revival** — `.github/workflows/ci.yml`:
  - `unit` job: typecheck + 262-test vitest suite with coverage on
    every PR.
  - `smoke` job: full xvfb + Chromium end-to-end against
    `examples/ocean-galleon`.
- **Reproducible coverage** — `@vitest/coverage-v8` is now a saved
  devDep; `npm run test:coverage` at root + every package.

### Notes

- Phase-1 unit-test coverage on the testable surface:
  - `@triscope/core` 68%
  - `@triscope/mcp` 62%
  - `@triscope/cli` 83%
  - `create-triscope` 97%

  The WebGPU lab runtime (`harness.ts`), the stdio MCP server
  (`server.ts`), and the Chromium browser pool (`createBrowserPool`)
  are exercised end-to-end by the smoke job in CI, not by unit
  tests — this is intentional; mocking WebGPU/CDP/stdio at the unit
  level gives line coverage without bug-catching value.

- `npm audit` reports 5 moderate vulnerabilities in the
  vitest/vite chain. Resolving them requires a major bump that has
  not been validated against the harness; deferred to 0.2.
