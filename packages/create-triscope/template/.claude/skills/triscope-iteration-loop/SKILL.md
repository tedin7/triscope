---
name: triscope-iteration-loop
description: Use when iterating on a 3D element in this triscope project (shader tuning, mesh adjustments, lighting). Lays out the edit → reload → telemetry/capture → adjust loop with the right tools at each step. Prefer numbers over screenshots for hidden state; use capture_views to look at all camera angles in one call.
---

# Triscope iteration loop

This project is built on triscope: every 3D element lives in
`src/elements/<name>.ts` and renders in its own multi-camera lab at
`/labs/<name>.html`. Each element declares cameras, knobs, and telemetry —
the framework handles the rest.

## The loop

```
  edit src/elements/<name>.ts            (e.g. drop roughness 0.4 → 0.2)
        │
        ▼  Vite HMR
  browser remounts element in the lab grid
        │
        ▼  ~500 ms
  /tmp/<project>-state.json updates
        │
        ▼  you ↓
  triscope state .elements.<name>        (numeric truth — FPS, uniforms)
  mcp:capture_views <name>               (visual truth — all N angles)
        │
        ▼  judge per-camera
  triscope smoke <name>                  (CI/sign-off gate)
```

## Rules learned the hard way (from water3d sessions)

- **Numbers beat screenshots for hidden state.** JPEG compression and the
  fact that a still can't show motion mean shader tuning by image alone is
  unreliable. Use `triscope state` to pull FPS, uniform values, lum stats.
- **Screenshots still win for shape and composition.** Use `capture_views`
  for layout, silhouette, glint placement, occlusion. Don't try to judge
  HDR tone from a screenshot — use numbers.
- **Set knobs with absolute values, not deltas.** Say "drop roughness 0.4 →
  0.2", not "decrease roughness slightly". The MCP `set_knob` tool takes an
  absolute value.
- **Verify per-camera.** A change can fix one pane and break another.
  "CHASE CAM looks right now" is not "all 8 panes look right now". Walk
  each named camera.
- **Reference photos beat memory.** If you have a reference image of what
  the element should look like, drop it into `refs/<name>/<camera>.png` so
  diffs are easy.

## Tools in this loop

- `triscope state [<jq.path>]`  — read /tmp/<project>-state.json
- `triscope list`               — registered elements + cameras + knobs
- `triscope smoke [<element>]`  — headed Chromium smoke test
- MCP `read_telemetry`          — same data, accessible to Claude
- MCP `set_knob`                — live update without reload (single or batched via {updates:[...]})
- MCP `capture_views`           — render every named camera; inline PNGs in the tool response
- MCP `set_reference` / `diff_reference` — store a reference photo, get a side-by-side + meanAbsDiff
- MCP `capture_motion`          — multi-frame filmstrips + motionMagnitude per camera (use for animated elements)
- MCP `run_smoke`               — `triscope smoke` as a tool

## When the element has motion

A single `capture_views` frame **cannot reveal whether motion is happening** —
sails could be at amplitude 0 just because you captured at the wrong phase, or
because windPressure isn't actually wired to deformation. Use these instead:

- **`capture_motion({ element, camera?, frames=6, dt=0.25, mode='time' })`** —
  returns one filmstrip image per camera (6 frames tiled left-to-right) plus a
  numeric `motionMagnitude[camera]` (0-255). Read the rule: <1 = static, >5 =
  visible motion, >20 = vigorous. If you expect motion (windPressure > 0) and
  magnitude is <1, the wiring is broken — not a tuning problem.
- **`read_telemetry .elements.<name>.motion`** — if the Element declared
  `motionProbes`, each probe exposes `{ latest, mean, min, max, peakToPeak,
  samples: lastN }`. peakToPeak ≈ 0 with non-zero input means the probe isn't
  changing — the animation isn't propagating to the state you're measuring.
- **Mode choice.** `mode: 'time'` is deterministic (steps `time.value`
  forward, ~instant) — use it for shader-driven motion (TSL uniforms, vertex
  displacement keyed to `ctx.time`). `mode: 'real'` waits dt seconds between
  frames — use it for CPU-integrated state (springs, particles).

## Editing shaders / TSL materials: full-reload, not HMR

The triscope vite plugin forces a **full page reload** instead of HMR when
files matching `(\.tsl|Element|Mesh|Material|Shader)\.(ts|tsx|js|mjs)$`
change. Reason: TSL materials end up baked into the renderer's node graph
when the scene mounts, so re-running the module after an edit has no
effect on the running THREE.Material — the new code never reaches the
renderer. Full-reload is the only reliable way to see shader edits.

Cost: ~1-2 s vs. ~50 ms HMR. Acceptable trade — the failure mode (edits
silently invisible) costs much more. Plain `.ts` files outside the
pattern still HMR normally.

To override the pattern or disable: pass `forceReloadOn` to the plugin in
your `vite.config.ts`:

```ts
triscopeTelemetryPlugin({
  forceReloadOn: /custom-pattern/i,   // or pass null to disable entirely
})
```

## Cold-start manifest: declare your labs in package.json

If your lab pages don't follow the `/labs/<element>.html` convention,
declare them in `package.json` so `mcp__triscope__capture_views` works
on the first call without `labUrl`:

```json
"triscope": {
  "labs": {
    "ship": "/triscope-ship.html",
    "ocean": "/triscope-ocean.html"
  }
}
```

The vite plugin reads this at boot and seeds `/__manifest` so the MCP
URL resolver returns the right URL immediately.

## Reactive loop (optional): the PostToolUse hook

`.claude/hooks.example.json` is a ready-to-paste hook config that wires
`triscope auto-capture` to run after every Edit/Write. The effect: the next
message to Claude includes a line like

  `[triscope] ship motion: sailWanderEnvelope p2p=0.59 freq=0.22Hz`

so Claude sees current FPS + probe activity automatically, without calling
`capture_views` or `read_telemetry`. If you edit shader code and the next
turn shows `p2p≈0` for a probe that was non-zero before, you broke motion.
To enable: copy the `"hooks"` block from `.claude/hooks.example.json` into
your `.claude/settings.local.json`.

## Inspect mode: click-to-select sub-meshes (no grep)

Open a lab with `?inspect=<element>` and the harness flips to a single
full-canvas camera with OrbitControls. Right-drag to orbit, scroll to
zoom, **left-click on a part of the mesh** to lock a selection. The
selection lands in `telemetry.selection` with the *exact source file
and line* where that mesh was added to the scene — no grep needed.

**From chat:** "ispeziona la nave" → Claude calls
`mcp__triscope__inspect element=ship`. The running browser flips into
inspect mode. The user clicks a sail; the next message has
`selection.source = { file: 'PirateShipMesh.ts', line: 1415, ... }`.

**Open the file at line:** `mcp__triscope__open_selection` reads
`telemetry.selection.source` and spawns `code --goto file:line:col` (or
honors $EDITOR). Use after the user says "open this" / "show me the
code". Sub-second: editor jumps to the right spot.

How it works without code changes: triscope monkey-patches
`Object3D.prototype.add` at runtime and tags every added object with
the user-code stack frame from `new Error().stack`. Element authors do
not modify their code — existing meshes get tagged on the next reload.
Vite source-maps make the frames resolve to original `.ts` files in
dev. The selection survives full-reload via localStorage (matched by
file:line, not Mesh UUID).

## Auto-tune: converge a knob on a reference

When you have a stored reference image for `(element, target_camera)`
and want to find the knob value that matches it visually:

```
mcp__triscope__auto_tune element=ship knob=windPressure
                          range=[0,2] target_camera=bow max_iterations=12
```

Golden-section search over the range, maximising SSIM (perceptual
similarity) against the reference. Each iteration: set_knob → 800ms
wait → captureViews → diff_reference. Converges to ~0.7% of the range
in 12 iters. Returns best knob value, final SSIM, full history. Leaves
the lab at the converged value so you see the result.

SSIM > meanAbsDiff as the objective: pixel-level diff chases anti-
aliasing noise and rewards "darken everything" as fake convergence;
SSIM tracks actual structural match.

## Snapshot / restore: cheap rollback via git tags

When a tuning pass lands somewhere good and you want to checkpoint
before a risky rewrite:

```
mcp__triscope__snapshot name=ship-mast-pass-v3 message="happy w/ sail bulge"
```

Refuses on a dirty WT (would silently lose your in-progress edits on
restore). Otherwise creates an annotated tag `triscope/snapshot/<name>`
whose message stores: HEAD commit + every persisted knob value across
all elements, as JSON. No working-tree files written, no rebase noise.

Restore later:
```
mcp__triscope__restore name=ship-mast-pass-v3
```
Checks out the commit (detached HEAD — branch from there if you want
to keep iterating) and re-posts every knob via `/__knob`. The live lab
snaps back to the recorded state within ~100 ms.

List what you have: `mcp__triscope__list_snapshots`.

## See also

- [[threejs-telemetry-sink]] — the read-pixel-into-JSON pattern triscope is built on.
- [[water-shader-convergence]] — for sea/water elements, the
  Tessendorf/Bruneton/Sea-of-Thieves checklist.
- [[glsl-pitfalls]] — when writing TSL/GLSL, the gotchas that cost half a
  day if you don't know about them up front.
