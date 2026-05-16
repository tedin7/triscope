# Triscope — a Three.js+WebGPU element-iteration framework


## Evidence — what the transcripts actually show

Before designing, I mined the 11 Claude transcripts of this project
(`/home/tomd/.claude/projects/-home-tomd-Documents-water3d/*.jsonl`, ~163 MB)
via 4 parallel Explore agents on cronological slices. Findings that shape
the design — some of which contradict naïve assumptions:

1. **The multi-view lab page was born from explicit user frustration**
   (May 13–14): *"ricostruisci da 0 su una pagina affianco il mare in varie
   dimensioni dall'alto di lato diagonale etc"*. Before that, screenshots
   were one 16:9 view and spatial bugs (cyan horizon, wide glint, missing
   ripple) were invisible. The grid is **the** load-bearing primitive.
2. **Elements were essentially never tuned in isolation.** Water → seafloor
   → ship were tight feedback loops because they mutually constrain
   (caustics legibility through tinted water; ship foam vs wave normals;
   bowl carve under ship). Solo-element tuning is a *mode within a composed
   scene*, not the framework's primary unit.
3. **Both telemetry and screenshots coexist.** Telemetry was introduced
   mid-project as an explicit pivot (*"Verify with telemetry, not
   screenshots"*) and works for hidden state (lum.mean was 0.55 not 0.45,
   FPS, uniform readback). But peak iteration (May 15) still used 278+85
   `mcp__claude-in-chrome__computer` screenshot calls — visual diagnosis
   wins for shape/composition; telemetry wins for HDR/numeric state.
4. **User issues precise numeric directives**, not adjectives: *"drop
   roughness 0.48 → 0.18"*, *"envMapIntensity 0.6 → 0.42"*, *"environment.intensity 0.14 → 0.35"*.
   The framework's tuning API must accept absolute values and the editor
   must show current values precisely.
5. **Verification is per-camera.** *"CHASE CAM looks right now"*,
   *"DIAGONAL HIGH still washed out"*. The smoke test should be able to
   fail on a specific pane.
6. **Reference photos are part of the loop.** *"Controlla le 6 immagini una
   per una e per ogni una trova i problemi che la rendono diversa da
   [reference]"*. Reference comparison should be a first-class primitive.
7. **Git checkout was used as visual undo.** Multiple manual rollbacks to
   earlier SHAs after failed experiments — small commits + cheap visual
   restore beats long uncommitted detours.
8. **Skills (water-shader-convergence, telemetry-sink) were invoked at the
   start of iteration cycles**, not as reference docs. The iteration-loop
   skill must link to them so they auto-load in fresh sessions.
9. **Knob taxonomy is nested + domain-specific.** `.water.fft.enabled`,
   `.water.foam.threshold`, `.water.refraction.depthAbsorption`. Framework
   must NOT impose a flat schema; each element exposes its own shape.
10. **Top tuned knobs by frequency** (across all sessions): foam strength,
    choppiness, macro amplitude, sparkle, exposure, environment.intensity,
    envMapIntensity, roughness floor, depth absorption, caustics intensity,
    bowl/clearance radii.

## Context

Over the water3d sessions we built — organically — a workflow that makes Claude
much better at iterating on 3D scenes:

1. **Multi-angle lab pages.** `lab.html` shows the whole scene from 12 cameras
   on one canvas (scissored viewports). `ship.html` shows the ship alone from
   8 angles (bow / stern / port / starboard / top / 3-4 front / 3-4 stern /
   deck close). Each element gets its own dedicated "lab" so we can judge it
   from every side without an orbit-camera ritual.
2. **Telemetry sink.** Browser POSTs FPS, uniforms, readPixels luma stats to a
   Vite middleware that writes `/tmp/water3d-state.json` + rolling log. The
   terminal queries it with `jq` instead of guessing from screenshots.
3. **Headed-Chromium smoke test.** `scripts/visual-webgpu.mjs` launches real
   Chromium with WebGPU enabled, evaluates DOM/runtime state via CDP, captures
   a screenshot, runs pixel-variance asserts, and fails on any console error.
4. **Project-scoped skills.** `.claude/skills/{threejs-telemetry-sink,
   water-shader-convergence, glsl-pitfalls}/SKILL.md` capture the lessons so
   future Claude sessions don't relearn them.
5. **Global runtime handle.** `window.__WATER3D_RUNTIME__` lets the smoke test
   and editor poke live scene state.
6. **Live tunable panel.** `labEditor.ts` hot-tunes uniforms without rebuilding
   WebGPU pipelines.

Together these turn 3D iteration from "edit → reload → squint at a screenshot
→ guess" into "edit → reload → read JSON + 12 angles → adjust the right
uniform → assert with a smoke test." This plan packages that loop as a reusable,
installable framework so any new Three.js+WebGPU project can adopt it on day one.

## Goals (revised after transcript evidence)

- **Composed-scene-first, element-solo as a mode.** The primary unit is the
  composed scene (what we called the lab). Each leaf element can be
  **soloed** (other elements hidden, cameras swap to that element's named
  presets) without leaving the page — like soloing a track in a DAW. This
  matches how iteration actually happened: water/seafloor/ship were always
  visible together, and the user mentally "zoomed" on one at a time.
- **Same self-describing contract for leaves and scenes.** Composition is
  still just an element-of-elements. But the canonical entry is the scene
  lab, not the leaf lab.
- **Two equal feedback channels — telemetry + multi-view screenshots.**
  Numbers win for hidden state (HDR, FPS, uniforms, lum stats); screenshots
  win for shape/composition. The framework provides primitives for both:
  `read_telemetry`, `capture_views` (all named cameras in one call). The
  iteration-loop skill tells AI when to use which.
- **Numeric, absolute-valued tuning.** Knobs accept absolute values, not
  deltas. Editor shows the current numeric value beside each slider. MCP
  `set_knob` takes `(element, key, value)`.
- **Per-camera assertions in the smoke test.** Smoke test runs per-named-camera
  and reports which panes failed (variance / luma bounds / console errors).
- **Reference-photo comparison as a primitive.** `triscope ref set <camera>
  <image>` stores a reference; `triscope ref diff <camera>` outputs side-by-side
  + numeric distance. MCP exposes the same.
- **Cheap visual restore.** `triscope snapshot "label"` commits current state
  to a `triscope/snapshots/` branch and tags it; `triscope restore <label>` checks
  it out. Replaces the manual `git checkout <SHA>` ritual from the transcripts.
- **AI-callable surfaces:**
  - **CLI** for scaffolding, dev, CI (`triscope init / new / dev / smoke / state / ref / snapshot`).
  - **MCP server** for live interaction with a running dev server
    (`list_elements`, `read_telemetry`, `set_knob`, `capture_views`,
    `run_smoke`, `solo`, `set_reference`, `diff_reference`, `snapshot`).
- **Hybrid adoption.** Thin runtime dep (`@triscope/core`) handles the lab
  harness + Vite telemetry plugin + scissored multi-camera renderer; CLI
  scripts, smoke harness, `.claude/skills/`, per-element knob/telemetry code
  are **scaffolded into the user's repo** so AI can edit them per-project.
- **Skill bundle wires itself.** The scaffolded `triscope-iteration-loop`
  skill links to `[[threejs-telemetry-sink]]`, `[[water-shader-convergence]]`,
  and `[[glsl-pitfalls]]` so a fresh session auto-discovers the right
  references before tuning.
- **Public GitHub repo, installable from npm.**

## Non-goals (v1)

- Renderer-agnostic core. v1 is Three.js + WebGPU (TSL friendly, but pure-WebGL
  Three.js works because it's the same scene API).
- Babylon / PlayCanvas / raw-WebGPU adapters.
- A scene editor GUI. Tunables are sliders + an MCP `set_knob` tool — that's
  the AI's editor.
- An asset pipeline. Users bring their own glTF / HDR.

---

## Architecture

```
triscope/                      (public GitHub monorepo, npm workspaces)
├── packages/
│   ├── core/                @triscope/core      — runtime: Element type, lab
│   │                                            harness, Vite telemetry plugin
│   ├── cli/                 @triscope/cli       — `triscope` binary
│   ├── mcp/                 @triscope/mcp       — MCP server for AI iteration
│   └── create-triscope/       npm init triscope   — scaffolder template
├── examples/
│   └── ocean-galleon/       — a working multi-element scene (sea, sky,
│                              seafloor, ship) built from the framework
└── docs/
```

### The `Element` contract (`@triscope/core`)

A self-describing module — one file per element:

```ts
import type { Element } from '@triscope/core';
import * as THREE from 'three/webgpu';

export const ship: Element = {
  name: 'ship',

  // Called once. Receives a parent Object3D and a shared context
  // (renderer, scene root, time uniform, asset loader).
  // Returns a handle the harness uses for unmount / setKnob / sample.
  mount: ({ parent, ctx }) => {
    const root = new THREE.Group();
    // ...build geometry/materials...
    parent.add(root);
    return { root, dispose: () => parent.remove(root) };
  },

  // Bounding box in local space — used for auto-framing cameras
  // when the user doesn't specify explicit ones.
  bounds: { min: [-15, -3, -4], max: [15, 12, 4] },

  // Named camera presets. Each gets one pane in the generated lab.
  // Position/target in element-local coords; `fit: true` auto-fits.
  cameras: {
    bow:         { position: [25, 6, 0],  target: [0, 4, 0] },
    stern:       { position: [-25, 6, 0], target: [0, 4, 0] },
    starboard:   { position: [0, 6, 25],  target: [0, 4, 0] },
    port:        { position: [0, 6, -25], target: [0, 4, 0] },
    top:         { position: [0, 40, 0],  target: [0, 0, 0] },
    'three-quarter-front': { position: [18, 12, 18], target: [0, 4, 0] },
    'three-quarter-stern': { position: [-18, 12, 18], target: [0, 4, 0] },
    'deck-close': { position: [4, 10, 0], target: [0, 8, 0], fov: 50 },
  },

  // Tunables: rendered as sliders in the lab editor AND exposed
  // to the MCP `set_knob` tool. Setting them must take effect live
  // without recreating WebGPU pipelines.
  knobs: {
    mastTilt:    { type: 'number', min: -0.2, max: 0.2, default: 0 },
    sailColor:   { type: 'color', default: '#d8c89a' },
    cannonCount: { type: 'int', min: 0, max: 10, default: 4 },
  },
  onKnob: (handle, key, value) => { /* live update */ },

  // Telemetry collectors. Return JSON-serializable values.
  // Merged into the global state snapshot under `elements.<name>`.
  telemetry: (handle, ctx) => ({
    triangles: handle.root.userData.triCount ?? 0,
    sailColor: handle.root.userData.sailColor,
  }),
};
```

#### Composition

A scene is just an element whose `mount` calls other elements' `mount`. The
parent declares its own outer cameras, its own knobs (e.g. ship position,
wind strength), and its own telemetry. The framework treats it identically
to a leaf element. Example skeleton (`examples/ocean-galleon/scene.ts`):

```ts
export const galleonScene: Element = {
  name: 'galleon-scene',
  mount: ({ parent, ctx }) => {
    const sky = mountElement(sky_, { parent, ctx });
    const sea = mountElement(ocean, { parent, ctx });
    const floor = mountElement(seafloor, { parent, ctx });
    const ship_ = mountElement(ship, { parent, ctx });
    return { dispose: () => [sky, sea, floor, ship_].forEach(h => h.dispose()) };
  },
  cameras: { topdown: …, droneTilt: …, chase: …, underwater: …, /* 8–12 */ },
  knobs: { windSpeed: …, sunAzimuth: …, shipX: … },
  telemetry: (_, ctx) => ({ fps: ctx.fps, lum: ctx.readbackLuma() }),
};
```

### The lab harness (`@triscope/core`)

One generic lab page (`labPage.ts`) is parameterized by an Element. The
scaffolder generates a tiny HTML stub per element (`labs/<name>.html`) that
points the harness at the element module. The harness:

- Mounts the element into a shared scene with one renderer.
- Renders each `cameras` entry into a scissored viewport on the single canvas
  (same trick `lab.html` uses today — cheap, one RAF, one WebGPU device).
- Builds the slider editor from `knobs`, wires `set_knob` over a `BroadcastChannel`
  for MCP, and renders a corner HUD with FPS + element name.
- Posts `{ perf, camera, elements: { <name>: telemetry() } }` to `/__state`
  every 500 ms via the Vite plugin (telemetry-sink pattern, generalized).
- Exposes `window.__TRISCOPE__ = { runtime, mountedElement, setKnob, sample }` so
  the smoke test and MCP server can reach in.

### The Vite plugin (`@triscope/core`)

Generalizes the water3d telemetry middleware:

- `POST /__state` → writes `/tmp/<project>-state.json` + appends to `/tmp/<project>-state.log`.
- `GET /__state` → returns latest snapshot.
- `POST /__knob` → broadcasts to all lab pages (live MCP edits).
- `GET /__manifest` → returns the union of registered elements (used by CLI/MCP for discovery).

Project name comes from `package.json#name` so two projects on the same
machine don't collide on `/tmp`.

### The CLI (`@triscope/cli`)

Single binary, scaffolded scripts wrap most commands:

| command | what it does |
|---|---|
| `triscope init` | `npm init triscope` equivalent: scaffolds Vite + Three.js + harness wiring + `.claude/skills/` |
| `triscope new element <name>` | adds `src/elements/<name>.ts` + `labs/<name>.html` from template |
| `triscope dev` | `vite dev` with telemetry plugin enabled |
| `triscope smoke [element]` | runs the headed-Chromium smoke harness; defaults to all labs, or one |
| `triscope state [<jq.path>]` | reads `/tmp/<project>-state.json`, optionally indexes into it |
| `triscope list` | lists registered elements + their cameras + knobs |

The smoke harness is the water3d `scripts/visual-webgpu.mjs` script,
generalized: it asserts the element's lab HUD is present, every named camera
pane renders non-black, no console errors fired, and the telemetry collector
returned a stable shape. Per-element extra assertions live in
`<name>.smoke.ts` if the user wants them.

### The MCP server (`@triscope/mcp`)

Connects to the running Vite dev server (default `http://localhost:5173`).
Tool list (expanded based on transcript evidence):

- `list_elements()` — names, cameras, knobs, current values.
- `read_telemetry(path?)` — full snapshot or jq-path slice from `/tmp/<proj>-state.json`.
- `set_knob(element, key, value)` — POST `/__knob`; live update, absolute value.
- `solo(element | null)` — hides all elements except one in the scene lab;
  swaps the camera grid to that element's named presets. `null` un-solos.
- `capture_views(element?)` — spawns Chromium (reuses the smoke harness),
  returns one PNG per named camera + a telemetry sample. Defaults to the
  scene's cameras when no element given.
- `run_smoke(element?)` — runs `triscope smoke`; returns per-camera pass/fail.
- `set_reference(camera, image_path)` — stores a reference photo for a named
  camera under `refs/<element>/<camera>.png`.
- `diff_reference(camera)` — captures current view at that camera, diffs
  against stored reference, returns side-by-side composite + perceptual
  distance (SSIM or simple ΔE).
- `snapshot(label)` — commits current working tree to `triscope/snapshots/<label>`
  branch + git tag. Cheap visual checkpoint before risky edits.
- `restore(label)` — git checkout of the snapshot.

### Skill pack (scaffolded into `.claude/skills/`)

Copied during `triscope init`, not shipped as a dep — so the AI can edit them
for the specific project:

- `triscope-iteration-loop` — the workflow: edit element → reload → read
  telemetry → capture views → adjust → repeat. Tells the AI to prefer numbers
  over screenshots.
- `threejs-telemetry-sink` — the existing skill, generalized for `@triscope/core`.
- `water-shader-convergence` — kept as-is, opt-in for sea/water elements.
- `glsl-pitfalls` — kept as-is, opt-in for shader work.

### Data flow (single iteration — matches the actual May 15 loop)

```
  AI edits  src/elements/ship.ts          (e.g. "drop mastTilt 0.2 → 0.1")
     │
     ▼  Vite HMR
  browser remounts ship in composed scene lab (12 cameras)
     │
     ▼  every 500 ms
  Telemetry POST /__state ─► /tmp/<proj>-state.json
     │
     ▼  AI calls (CLI or MCP)
  mcp:solo ship                                (isolate, swap to ship cameras)
  mcp:capture_views ship                       (8 angle PNGs in one call)
  mcp:read_telemetry .elements.ship            (numeric state)
  mcp:diff_reference deck-close                (vs stored reference photo)
     │
     ▼  AI judges per-camera, edits, repeats
  mcp:snapshot "ship-mast-pass"                (when a milestone holds)
  triscope smoke ship                            (CI/sign-off gate)
     │
     ▼
  AI decides next edit OR escalates to user
```

---

## Critical files (in this repo) used as reference for the framework

These are the load-bearing patterns to lift / generalize:

- `lab.html` + `ship.html` — multi-camera lab layout, labels, boot overlay.
- `src/lab/views/` — camera creation + scissored grid rendering.
- `src/lab/labEditor.ts` — live slider editor wired to runtime setters.
- `src/lab/runtime.ts` — scene/renderer/element assembly with live `setXxx()` API.
- `scripts/visual-webgpu.mjs` — headed Chromium + CDP + pixel-variance asserts.
- `vite.config.js` — telemetry middleware (currently project-local).
- `.claude/skills/threejs-telemetry-sink/SKILL.md` — the published recipe.
- `.claude/skills/water-shader-convergence/SKILL.md` — domain-specific lessons.
- `.claude/skills/glsl-pitfalls/SKILL.md` — domain-specific lessons.

---

## Build sequence

1. **Bootstrap monorepo.** Create the public GitHub repo with npm workspaces
   (`packages/core`, `packages/cli`, `packages/mcp`, `packages/create-triscope`,
   `examples/`). MIT licence. CI: lint + typecheck + smoke on the example.
2. **`@triscope/core` MVP.** Element type, harness, scissored multi-camera
   renderer, Vite telemetry plugin, `window.__TRISCOPE__` handle. Port the
   minimum from `src/lab/` + `vite.config.js`.
3. **`create-triscope` scaffolder.** Generates a Vite project that uses `@triscope/core`,
   one example element, `.claude/skills/`, the smoke harness script, a
   `package.json` with `triscope` scripts.
4. **`@triscope/cli`.** `init` (delegates to `create-triscope`), `new element`,
   `dev`, `smoke`, `state`, `list`. The smoke command is the generalized
   `visual-webgpu.mjs` keyed by element name.
5. **`@triscope/mcp`.** Implements the five tools above against the dev server.
6. **Reference example: `examples/ocean-galleon`.** Port water3d's sea, sky,
   seafloor, and ship as four standalone elements + one composed scene. This
   is the smoke test for the framework itself: if the four water3d elements
   still look right under Triscope, the framework holds.
7. **Skill pack & README.** Write the iteration-loop skill, copy the existing
   three. README shows the loop: `triscope init` → `triscope new element rope` →
   AI iterates via MCP → `triscope smoke rope` → green.
8. **Publish.** `@triscope/*` to npm, repo public on GitHub.

---

## Verification — how we know it works end-to-end

The reference example is the verification. After step 6:

1. `npx create-triscope demo-galleon` scaffolds a working project in a clean dir.
2. `cd demo-galleon && npm install && npm run dev` boots Vite; opening
   `/labs/scene.html` (the canonical entry) shows 12 composed views;
   `/labs/ship.html` shows 8 ship angles (leaf lab).
3. `triscope list` prints `ship, sea, sky, seafloor, scene` with cameras, knobs,
   and current values.
4. `triscope state .elements.scene.fps` returns a number > 30.
5. MCP `set_knob('ship', 'mastTilt', 0.1)` visibly tilts the mast within one
   frame; `read_telemetry .elements.ship` reflects it.
6. MCP `solo('ship')` hides sea/sky/seafloor and swaps the grid to ship cameras
   in the same page; `solo(null)` restores.
7. MCP `capture_views('ship')` returns 8 non-black PNGs + a stable telemetry
   JSON in one call.
8. MCP `set_reference('deck-close', './refs/ship-deck.png')` then
   `diff_reference('deck-close')` returns a side-by-side composite + a
   numeric distance.
9. MCP `snapshot('milestone-A')` creates `triscope/snapshots/milestone-A`
   branch+tag; `restore('milestone-A')` checks it out.
10. `triscope smoke` exits 0 and prints per-camera pass/fail; corrupting a
    shader makes it exit non-zero with a console-error line and which pane(s)
    failed.
11. `.claude/skills/triscope-iteration-loop/SKILL.md` is in the scaffolded repo,
    is discovered by Claude Code at session start, and `[[wikilinks]]` to the
    three water3d skills resolve.

If all eleven pass, the framework reproduces — and codifies — the iteration
loop we built ad-hoc in water3d, and can be adopted by any new Three.js+WebGPU
project with one command.
