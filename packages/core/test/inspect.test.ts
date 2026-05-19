// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildParentChain, describeObj, findMeshBySource, readInspectFromUrl } from '../src/inspect.js';

/**
 * These tests only cover the pure helpers that don't need WebGPU.
 * The full createInspectMode flow needs a renderer + OrbitControls and is
 * better exercised by an end-to-end smoke (out of phase-1 scope).
 */

function stubObj(opts: {
  name?: string;
  ctorName?: string;
  geometryType?: string;
  color?: string;
  parent?: any;
} = {}): any {
  const o: any = {
    name: opts.name ?? '',
    parent: opts.parent ?? null,
    userData: {},
  };
  // Mimic constructor.name without using `class`.
  Object.defineProperty(o, 'constructor', { value: { name: opts.ctorName ?? 'Object3D' } });
  if (opts.geometryType) o.geometry = { type: opts.geometryType };
  if (opts.color) o.material = { color: { getHexString: () => opts.color!.replace(/^#/, '') } };
  return o;
}

describe('describeObj', () => {
  it('returns the .name when set', () => {
    expect(describeObj(stubObj({ name: 'hero' }))).toBe('hero');
  });

  it('falls back to ctor name when nothing else is known', () => {
    expect(describeObj(stubObj({ ctorName: 'Group' }))).toBe('Group');
  });

  it('appends geometry type when present', () => {
    expect(describeObj(stubObj({ ctorName: 'Mesh', geometryType: 'BoxGeometry' }))).toBe('Mesh<BoxGeometry>');
  });

  it('appends color hex when material exposes getHexString', () => {
    expect(describeObj(stubObj({ ctorName: 'Mesh', color: '#abcdef' }))).toBe('Mesh<#abcdef>');
  });

  it('appends both geometry and color when both are present', () => {
    const o = stubObj({ ctorName: 'Mesh', geometryType: 'PlaneGeometry', color: '#112233' });
    expect(describeObj(o)).toBe('Mesh<PlaneGeometry #112233>');
  });

  it('survives a throwing color extractor', () => {
    const o: any = stubObj({ ctorName: 'Mesh', geometryType: 'BoxGeometry' });
    o.material = { color: { getHexString: () => { throw new Error('boom'); } } };
    expect(describeObj(o)).toBe('Mesh<BoxGeometry>');
  });
});

describe('buildParentChain', () => {
  it('walks .parent up to the root, root-first', () => {
    const root = stubObj({ name: 'Scene' });
    const mid = stubObj({ name: 'group', parent: root });
    const leaf = stubObj({ name: 'leaf', parent: mid });
    expect(buildParentChain(leaf)).toEqual(['Scene', 'group', 'leaf']);
  });

  it('returns a single element for a parentless object', () => {
    expect(buildParentChain(stubObj({ name: 'alone' }))).toEqual(['alone']);
  });
});

describe('findMeshBySource', () => {
  function makeScene(meshes: any[]) {
    return {
      traverse(cb: (o: any) => void) {
        for (const m of meshes) cb(m);
      },
    } as any;
  }

  it('returns null when source is null or has no file', () => {
    const scene = makeScene([]);
    expect(findMeshBySource(scene, null)).toBeNull();
    expect(findMeshBySource(scene, { file: '', line: 0, col: 0 })).toBeNull();
  });

  it('matches by exact file + line', () => {
    const target = { userData: { __tris: { source: { file: '/a.ts', line: 10, col: 1 }, stack: [], type: 'Mesh' } } };
    const other = { userData: { __tris: { source: { file: '/b.ts', line: 10, col: 1 }, stack: [], type: 'Mesh' } } };
    const scene = makeScene([other, target]);
    expect(findMeshBySource(scene, { file: '/a.ts', line: 10, col: 1 })).toBe(target);
  });

  it('returns null when no mesh matches', () => {
    const scene = makeScene([
      { userData: { __tris: { source: { file: '/a.ts', line: 1, col: 1 }, stack: [], type: 'Mesh' } } },
    ]);
    expect(findMeshBySource(scene, { file: '/a.ts', line: 2, col: 1 })).toBeNull();
  });

  it('tolerates a scene with no .traverse method', () => {
    expect(findMeshBySource({} as any, { file: '/x.ts', line: 1, col: 1 })).toBeNull();
  });
});

describe('readInspectFromUrl', () => {
  function setLocation(search: string) {
    // jsdom location is writable via History; use href assignment.
    window.history.replaceState(null, '', `/?${search.replace(/^\?/, '')}`);
  }

  it('returns null when no ?inspect param is present', () => {
    setLocation('');
    expect(readInspectFromUrl('ship')).toBeNull();
  });

  it('activates on bare ?inspect', () => {
    setLocation('inspect');
    expect(readInspectFromUrl('ship')).toEqual({ camera: undefined });
  });

  it('activates on ?inspect=1', () => {
    setLocation('inspect=1');
    expect(readInspectFromUrl('ship')).toEqual({ camera: undefined });
  });

  it('activates when ?inspect matches the element name', () => {
    setLocation('inspect=ship&camera=bow');
    expect(readInspectFromUrl('ship')).toEqual({ camera: 'bow' });
  });

  it('does NOT activate when ?inspect is a different element name', () => {
    setLocation('inspect=water');
    expect(readInspectFromUrl('ship')).toBeNull();
  });

  it('returns null in a non-browser environment', () => {
    const origWindow = (globalThis as any).window;
    delete (globalThis as any).window;
    try {
      expect(readInspectFromUrl('ship')).toBeNull();
    } finally {
      (globalThis as any).window = origWindow;
    }
  });
});
