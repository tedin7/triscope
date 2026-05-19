import { describe, expect, it } from 'vitest';
import { composeElements } from '../src/compose.js';
import type { Element, MountContext, MountHandle } from '../src/types.js';

/**
 * composeElements is pure JS scaffolding around Element — none of these
 * tests need WebGPU or a renderer. We fabricate fake elements that just
 * record their onKnob calls and return canned telemetry, then verify the
 * composite routes correctly.
 */

function fakeElement(
  name: string,
  opts: {
    cameras?: Record<
      string,
      { position: [number, number, number]; target: [number, number, number] }
    >;
    knobs?: Record<string, any>;
    bounds?: { min: [number, number, number]; max: [number, number, number] };
  } = {},
): Element & { onKnobCalls: Array<[string, unknown]>; mountCount: number } {
  const onKnobCalls: Array<[string, unknown]> = [];
  let mountCount = 0;
  const el: Element & { onKnobCalls: typeof onKnobCalls; mountCount: number } = {
    name,
    cameras: opts.cameras ?? { default: { position: [0, 0, 5], target: [0, 0, 0] } },
    knobs: opts.knobs ?? {},
    bounds: opts.bounds,
    mount: () => {
      mountCount += 1;
      return {
        root: { isObject3D: true, children: [] } as unknown as MountHandle['root'],
        dispose: () => {},
        userData: { tag: `mounted-${name}` },
      };
    },
    onKnob: (_h, key, value) => {
      onKnobCalls.push([key, value]);
    },
    telemetry: () => ({ from: name }),
    motionProbes: {
      pulse: () => 1.5,
    },
    onKnobCalls,
    mountCount,
  };
  // The closures above capture the same arrays — return el so tests can read them.
  Object.defineProperty(el, 'onKnobCalls', { get: () => onKnobCalls });
  Object.defineProperty(el, 'mountCount', { get: () => mountCount });
  return el;
}

function fakeCtx(): MountContext {
  return { renderer: {} as any, scene: {} as any, time: { value: 0 }, dt: { value: 0 } };
}

describe('composeElements', () => {
  it('throws on empty input', () => {
    expect(() => composeElements([])).toThrow(/non-empty array/);
  });

  it('namespaces cameras with <elName>.<camName>', () => {
    const a = fakeElement('ship', { cameras: { bow: { position: [1, 0, 0], target: [0, 0, 0] } } });
    const b = fakeElement('water', {
      cameras: { top: { position: [0, 5, 0], target: [0, 0, 0] } },
    });
    const composite = composeElements([a, b]);
    expect(Object.keys(composite.cameras).sort()).toEqual(['ship.bow', 'water.top']);
  });

  it('namespaces knobs', () => {
    const a = fakeElement('ship', {
      knobs: { windPressure: { type: 'number', min: 0, max: 2, default: 0.6 } },
    });
    const b = fakeElement('water', {
      knobs: { depth: { type: 'number', min: 0, max: 100, default: 50 } },
    });
    const composite = composeElements([a, b]);
    expect(Object.keys(composite.knobs ?? {}).sort()).toEqual(['ship.windPressure', 'water.depth']);
  });

  it('routes onKnob to the right child by namespace', () => {
    const a = fakeElement('ship', {
      knobs: { windPressure: { type: 'number', min: 0, max: 2, default: 0.6 } },
    });
    const b = fakeElement('water', {
      knobs: { depth: { type: 'number', min: 0, max: 100, default: 50 } },
    });
    const composite = composeElements([a, b]);
    const ctx = fakeCtx();
    const handle = composite.mount({ parent: { isObject3D: true } as any, ctx });
    composite.onKnob!(handle, 'ship.windPressure', 1.6);
    composite.onKnob!(handle, 'water.depth', 75);
    expect(a.onKnobCalls).toEqual([['windPressure', 1.6]]);
    expect(b.onKnobCalls).toEqual([['depth', 75]]);
  });

  it('returns merged telemetry keyed by element name', () => {
    const a = fakeElement('ship');
    const b = fakeElement('water');
    const composite = composeElements([a, b]);
    const ctx = fakeCtx();
    const handle = composite.mount({ parent: { isObject3D: true } as any, ctx });
    const tel = composite.telemetry!(handle, ctx);
    expect(tel).toEqual({ ship: { from: 'ship' }, water: { from: 'water' } });
  });

  it('namespaces motion probes', () => {
    const a = fakeElement('ship');
    const b = fakeElement('water');
    const composite = composeElements([a, b]);
    expect(Object.keys(composite.motionProbes ?? {}).sort()).toEqual(['ship.pulse', 'water.pulse']);
    const ctx = fakeCtx();
    const handle = composite.mount({ parent: { isObject3D: true } as any, ctx });
    const shipPulse = composite.motionProbes!['ship.pulse'](handle, ctx);
    expect(shipPulse).toBe(1.5);
  });

  it('union of bounds', () => {
    const a = fakeElement('ship', { bounds: { min: [-1, -1, -1], max: [1, 1, 1] } });
    const b = fakeElement('water', { bounds: { min: [-10, -10, -10], max: [10, 10, 10] } });
    const composite = composeElements([a, b]);
    expect(composite.bounds).toEqual({ min: [-10, -10, -10], max: [10, 10, 10] });
  });

  it('mounts every child exactly once', () => {
    const a = fakeElement('ship');
    const b = fakeElement('water');
    const c = fakeElement('sky');
    const composite = composeElements([a, b, c]);
    const ctx = fakeCtx();
    composite.mount({ parent: { isObject3D: true } as any, ctx });
    expect(a.mountCount).toBe(1);
    expect(b.mountCount).toBe(1);
    expect(c.mountCount).toBe(1);
  });

  it('opts.name overrides the default composite name', () => {
    const a = fakeElement('ship');
    const composite = composeElements([a], { name: 'scene' });
    expect(composite.name).toBe('scene');
  });
});
