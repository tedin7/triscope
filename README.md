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

> **Status: pre-alpha.** Bootstrapping the monorepo. Nothing here works yet.
> See [`docs/design.md`](./docs/design.md) for the design.

## The shape

```
triscope/
├── packages/
│   ├── core/                @triscope/core      — runtime: Element contract,
│   │                                              multi-camera lab harness,
│   │                                              Vite telemetry plugin
│   ├── cli/                 @triscope/cli       — `triscope` binary
│   ├── mcp/                 @triscope/mcp       — MCP server for live AI control
│   └── create-triscope/     npm init triscope   — scaffolder
├── examples/
│   └── ocean-galleon/       reference scene: sea, sky, seafloor, ship
└── docs/                    design + recipes
```

## The iteration loop (target)

```
  AI edits  src/elements/ship.ts          ("drop mastTilt 0.2 → 0.1")
     │
     ▼  Vite HMR
  browser remounts ship in composed scene lab (N cameras)
     │
     ▼  every 500 ms
  telemetry POST /__state ─► /tmp/<proj>-state.json
     │
     ▼  AI calls (CLI or MCP)
  triscope solo ship                          (isolate, swap to ship cameras)
  triscope capture-views ship                 (N angle PNGs in one call)
  triscope state .elements.ship               (numeric state)
  triscope ref diff ship deck-close           (vs stored reference photo)
     │
     ▼  AI judges per-camera, edits, repeats
  triscope snapshot ship-mast-pass            (cheap visual checkpoint)
  triscope smoke ship                         (CI/sign-off gate)
```

## Element contract (target)

```ts
import type { Element } from '@triscope/core';
import * as THREE from 'three/webgpu';

export const ship: Element = {
  name: 'ship',
  mount: ({ parent, ctx }) => { /* … */ },
  bounds: { min: [-15, -3, -4], max: [15, 12, 4] },
  cameras: { bow: { position: [25, 6, 0], target: [0, 4, 0] }, /* … */ },
  knobs: {
    mastTilt:  { type: 'number', min: -0.2, max: 0.2, default: 0 },
    sailColor: { type: 'color', default: '#d8c89a' },
  },
  onKnob: (handle, key, value) => { /* live update */ },
  telemetry: (handle, ctx) => ({ triangles: handle.root.userData.triCount }),
};
```

Composition is just an element that mounts other elements. Same contract
everywhere.

## License

MIT
