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

## See also

- [[threejs-telemetry-sink]] — the read-pixel-into-JSON pattern triscope is built on.
- [[water-shader-convergence]] — for sea/water elements, the
  Tessendorf/Bruneton/Sea-of-Thieves checklist.
- [[glsl-pitfalls]] — when writing TSL/GLSL, the gotchas that cost half a
  day if you don't know about them up front.
