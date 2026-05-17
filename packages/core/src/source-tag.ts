/**
 * Auto source-tag for the scene graph.
 *
 * Monkey-patches THREE.Object3D.prototype.add exactly once so every object
 * added to a scene gets a userData.__tris record containing the user
 * source frame (file:line + fn name from V8 stack), the object class, the
 * geometry class, and a material hint.
 *
 * Element authors do not call anything. The tag appears on every mesh
 * added via .add(), Three's standard pattern. The picker in inspect.ts
 * reads this back when the user clicks, so we map "this pixel on screen"
 * to "this exact line in your code" without grep.
 *
 * Stack parsing skips any frame inside three/, @triscope/, or
 * node_modules/. In vite dev mode the stack is already source-mapped,
 * resolving to original .ts source files. Production minified builds
 * lose the precision but triscope is dev-only.
 */
import * as THREE from 'three/webgpu';

export interface SourceFrame {
  file: string;
  line: number;
  col: number;
  fn?: string;
}

export interface SourceTag {
  source: SourceFrame | null;
  stack: SourceFrame[];
  type: string;
  geometry?: string;
  material?: { color?: string; map?: string | null };
  name?: string;
  /**
   * Names of ancestor objects in the scene tree, root-first. Populated
   * lazily when the picker reads the tag (parents may change after
   * .add() if the user re-parents). Useful as a tie-breaker when the
   * source-line attribution drifts (see note below).
   */
  parentChain?: string[];
}

/**
 * Note on line accuracy: in browser dev mode, `new Error().stack` returns
 * positions in the file as vite served it (after esbuild's TS-to-JS
 * transform). Vite tries to preserve line counts but TSL `Fn(([uv]) => …)`
 * blocks and other complex constructions can drift by tens of lines.
 * The captured line is therefore "approximate" — close enough for
 * `code --goto` to land in the right neighborhood, but verify visually
 * (or use `parentChain` + `geometry` + `material.color` as cross-checks)
 * before assuming it's exact.
 */

let patched = false;

export function installSourceTagPatch(): boolean {
  if (patched) return false;
  patched = true;
  const origAdd = THREE.Object3D.prototype.add;
  THREE.Object3D.prototype.add = function (...children: THREE.Object3D[]) {
    let stack: SourceFrame[] = [];
    try {
      const raw = new Error().stack ?? '';
      stack = parseUserStack(raw);
    } catch { /* stack capture is best-effort */ }
    const source = stack[0] ?? null;
    for (const child of children) {
      if (!child) continue;
      const prior = child.userData?.__tris as SourceTag | undefined;
      if (prior && prior.source) continue;
      const tag: SourceTag = {
        source,
        stack,
        type: child.constructor.name,
      };
      const asMesh = child as THREE.Mesh;
      if (asMesh.geometry) tag.geometry = asMesh.geometry.type;
      if (asMesh.material) tag.material = extractMaterialHint(asMesh.material);
      if (child.name) tag.name = child.name;
      child.userData = child.userData ?? {};
      (child.userData as Record<string, unknown>).__tris = tag;
    }
    return origAdd.apply(this, children);
  } as typeof origAdd;
  return true;
}

const FRAME_RE = /at (?:(?<fn>[^(]+?) \()?(?<url>[^()]+?):(?<line>\d+):(?<col>\d+)\)?$/;

const SKIP_PATTERNS = [
  /\/node_modules\//,
  /\/three\//,
  /\/@triscope\//,
  /\/triscope\/packages\//,
  /\/(harness|source-tag|inspect|editor|telemetry)\.[jt]sx?/,
  /^node:/,
  /^(?:webpack|vite):/,
];

function parseUserStack(raw: string, max = 8): SourceFrame[] {
  const out: SourceFrame[] = [];
  for (const lineStr of raw.split('\n')) {
    const m = FRAME_RE.exec(lineStr.trim());
    if (!m?.groups) continue;
    const url = stripUrl(m.groups.url);
    if (SKIP_PATTERNS.some((p) => p.test(url))) continue;
    out.push({
      file: url,
      line: Number(m.groups.line),
      col: Number(m.groups.col),
      fn: m.groups.fn || undefined,
    });
    if (out.length >= max) break;
  }
  return out;
}

function stripUrl(u: string): string {
  return u.replace(/[?#].*$/, '');
}

function extractMaterialHint(material: unknown): { color?: string; map?: string | null } {
  const m = material as {
    color?: { getHexString?: () => string };
    map?: { name?: string; source?: { data?: { src?: string } } };
  };
  const hint: { color?: string; map?: string | null } = {};
  try { if (m?.color?.getHexString) hint.color = '#' + m.color.getHexString(); } catch {}
  try {
    const tex = m?.map;
    if (tex) hint.map = tex.name || tex.source?.data?.src || null;
  } catch {}
  return hint;
}
