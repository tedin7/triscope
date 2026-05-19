import { describe, expect, it } from 'vitest';
import {
  extractMaterialHint,
  FRAME_RE,
  installSourceTagPatch,
  parseUserStack,
  SKIP_PATTERNS,
  stripUrl,
} from '../src/source-tag.js';

/**
 * The patch monkey-patches THREE.Object3D.prototype.add globally and
 * memoises with a module-level flag, so it can patch only once per
 * process. Tests below are order-independent: we ensure the patch is
 * installed, then assert observable behaviour. The dedicated idempotency
 * assertion (any subsequent call is a no-op) holds regardless of who
 * called installSourceTagPatch() first.
 */
describe('installSourceTagPatch', () => {
  it('is idempotent: any call after the first one returns false', async () => {
    installSourceTagPatch(); // ensure installed (no-op if already)
    expect(installSourceTagPatch()).toBe(false);
    expect(installSourceTagPatch()).toBe(false);
  });

  it('after installation, .add() actually swaps to the patched implementation', async () => {
    installSourceTagPatch();
    const THREE = await import('three/webgpu');
    // The patch produces a function whose source contains our tag-writing
    // logic; we don't snapshot the source, but we can verify the visible
    // side-effect: a brand-new mesh added to a brand-new scene gets a
    // userData.__tris record.
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    expect(mesh.userData?.__tris).toBeUndefined();
    scene.add(mesh);
    expect(mesh.userData?.__tris).toBeDefined();
  });

  it('tags newly-added meshes with userData.__tris.source', async () => {
    const THREE = await import('three/webgpu');
    installSourceTagPatch();
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial({ color: 0xff00ff }),
    );
    scene.add(mesh);
    const tag = mesh.userData?.__tris as
      | { type: string; geometry?: string; material?: { color?: string } }
      | undefined;
    expect(tag).toBeDefined();
    expect(tag!.type).toBe('Mesh');
    expect(tag!.geometry).toBe('BoxGeometry');
    expect(tag!.material?.color).toBe('#ff00ff');
  });

  it('does not overwrite an existing source tag', async () => {
    const THREE = await import('three/webgpu');
    installSourceTagPatch();
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    mesh.userData = {
      __tris: {
        source: { file: '/preset.ts', line: 1, col: 1 },
        stack: [],
        type: 'Custom',
      },
    };
    scene.add(mesh);
    expect((mesh.userData.__tris as { type: string }).type).toBe('Custom');
  });

  it('captures the Object3D name when present', async () => {
    const THREE = await import('three/webgpu');
    installSourceTagPatch();
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    mesh.name = 'hero';
    scene.add(mesh);
    expect((mesh.userData.__tris as { name?: string }).name).toBe('hero');
  });
});

describe('parseUserStack', () => {
  it('returns [] for empty input', () => {
    expect(parseUserStack('')).toEqual([]);
  });

  it('parses Chrome-style frames with function name', () => {
    const raw = [
      'Error',
      '    at mountShip (/home/u/project/src/Ship.ts:42:11)',
      '    at runLab (/home/u/project/node_modules/@triscope/core/dist/harness.js:99:7)',
    ].join('\n');
    const out = parseUserStack(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      file: '/home/u/project/src/Ship.ts',
      line: 42,
      col: 11,
      fn: 'mountShip',
    });
  });

  it('parses anonymous frames without function name', () => {
    const raw = '    at /home/u/project/src/Ship.ts:42:11';
    const out = parseUserStack(raw);
    expect(out).toHaveLength(1);
    expect(out[0].fn).toBeUndefined();
  });

  it('skips frames in three/, @triscope/, node_modules/, node:, vite:', () => {
    const raw = [
      '    at Inner (/home/u/proj/node_modules/three/Object3D.js:1:1)',
      '    at Outer (/home/u/proj/node_modules/@triscope/core/x.js:2:2)',
      '    at Web (/home/u/proj/three/webgpu.js:3:3)',
      '    at Vit (vite:client:4:4)',
      '    at Nod (node:internal/process:5:5)',
      '    at Real (/home/u/proj/src/MyElement.ts:7:7)',
    ].join('\n');
    const out = parseUserStack(raw);
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe('/home/u/proj/src/MyElement.ts');
  });

  it('caps the returned frames at `max`', () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`    at f${i} (/home/u/proj/src/file${i}.ts:${i}:1)`);
    }
    const out = parseUserStack(lines.join('\n'), 3);
    expect(out).toHaveLength(3);
  });

  it('strips ?query and #hash off urls', () => {
    const raw = '    at foo (/src/a.ts?t=123:10:3)';
    const out = parseUserStack(raw);
    expect(out[0].file).toBe('/src/a.ts');
  });
});

describe('stripUrl', () => {
  it('removes ? and # tails', () => {
    expect(stripUrl('/a.ts?v=1')).toBe('/a.ts');
    expect(stripUrl('/a.ts#sourcemap')).toBe('/a.ts');
    expect(stripUrl('/a.ts?v=1#x')).toBe('/a.ts');
    expect(stripUrl('/plain')).toBe('/plain');
  });
});

describe('FRAME_RE / SKIP_PATTERNS exports', () => {
  it('FRAME_RE captures `fn`, `url`, `line`, `col` named groups', () => {
    const m = FRAME_RE.exec('at f (/x.ts:1:2)');
    expect(m?.groups?.fn).toBe('f');
    expect(m?.groups?.url).toBe('/x.ts');
    expect(m?.groups?.line).toBe('1');
    expect(m?.groups?.col).toBe('2');
  });

  it('SKIP_PATTERNS list contains the documented patterns', () => {
    const joined = SKIP_PATTERNS.map((p) => p.source).join('|');
    expect(joined).toMatch(/node_modules/);
    expect(joined).toMatch(/three/);
    expect(joined).toMatch(/@triscope/);
  });
});

describe('extractMaterialHint', () => {
  it('returns {} for null/garbage input', () => {
    expect(extractMaterialHint(null)).toEqual({});
    expect(extractMaterialHint({})).toEqual({});
    expect(extractMaterialHint(42)).toEqual({});
  });

  it('extracts color via getHexString', () => {
    const mat = { color: { getHexString: () => 'abcdef' } };
    expect(extractMaterialHint(mat).color).toBe('#abcdef');
  });

  it('extracts map name when present', () => {
    const mat = { map: { name: 'wood' } };
    expect(extractMaterialHint(mat).map).toBe('wood');
  });

  it('falls back to map.source.data.src when name is missing', () => {
    const mat = { map: { name: '', source: { data: { src: 'foo.png' } } } };
    expect(extractMaterialHint(mat).map).toBe('foo.png');
  });

  it('returns map=null when texture exists but has no name or src', () => {
    const mat = { map: {} };
    expect(extractMaterialHint(mat).map).toBeNull();
  });

  it('tolerates color.getHexString throwing', () => {
    const mat = {
      color: {
        getHexString: () => {
          throw new Error('oops');
        },
      },
    };
    expect(extractMaterialHint(mat)).toEqual({});
  });
});
