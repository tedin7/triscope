/**
 * composeElements — fold multiple Elements into one composite Element.
 *
 * The Element contract is already enough for composition (the README has
 * said "composition is just an element that mounts other elements" from
 * day one) but writing the boilerplate by hand is tedious. This helper
 * does the bookkeeping: it merges cameras, knobs, motionProbes, events,
 * and telemetry under a `<elementName>.<key>` namespace so two elements
 * declaring a camera both named "top" don't collide.
 *
 * Pass the result to runLab(). Inspect mode keeps working — each
 * underlying element's meshes still get their own auto source-tags
 * (the patch is global, not per-element).
 *
 * Knob routing: when the harness calls onKnob('ship.windPressure', x),
 * we split on the first dot, find the matching element, and forward to
 * its onKnob with the un-prefixed key ('windPressure').
 */
import type { Element, MountContext, MountHandle, TriscopeEvent } from './types.js';

export interface ComposeOptions {
  /** Name of the composite element. Used for the state file + manifest. Default: 'composite'. */
  name?: string;
  /** Override the auto-computed bounds (union of children's). */
  bounds?: Element['bounds'];
  /** Override the lab URL (otherwise inherits the first child's). */
  labUrl?: string;
}

interface ChildHandles {
  handles: MountHandle[];
}

export function composeElements(elements: Element[], opts: ComposeOptions = {}): Element {
  if (!Array.isArray(elements) || elements.length === 0) {
    throw new Error('composeElements: pass a non-empty array of Element');
  }
  const name = opts.name ?? 'composite';
  const labUrl = opts.labUrl ?? elements[0]?.labUrl;
  const bounds = opts.bounds ?? unionBounds(elements);

  // Pre-build the merged camera/knob/motionProbe maps so the Element shape
  // is correct before mount runs. onKnob/telemetry/motionProbes/events
  // close over `elements` (static) and reach into handle.userData.handles
  // (the live MountHandle list) for per-element lookups.
  const cameras: Element['cameras'] = {};
  const knobs: Element['knobs'] = {};
  const motionProbes: Element['motionProbes'] = {};
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    for (const [cn, c] of Object.entries(el.cameras ?? {})) {
      cameras[nsKey(el.name, cn)] = c;
    }
    for (const [kn, k] of Object.entries(el.knobs ?? {})) {
      (knobs as Record<string, any>)[nsKey(el.name, kn)] = k;
    }
    for (const [pn, p] of Object.entries(el.motionProbes ?? {})) {
      const idx = i; // capture
      (motionProbes as Record<string, any>)[nsKey(el.name, pn)] = (
        handle: MountHandle,
        ctx: MountContext,
      ) => {
        const childHandle = (handle.userData as unknown as ChildHandles)?.handles?.[idx];
        return childHandle ? p(childHandle, ctx) : 0;
      };
    }
  }

  return {
    name,
    labUrl,
    bounds,
    cameras,
    knobs,
    mount: ({ parent, ctx }) => {
      const handles: MountHandle[] = elements.map((el) => el.mount({ parent, ctx }));
      return {
        root: parent,
        userData: { handles } as unknown as Record<string, unknown>,
        dispose: () => {
          for (const h of handles) {
            try {
              h.dispose();
            } catch {
              /* keep tearing down the rest */
            }
          }
        },
      };
    },
    onKnob: (handle, key, value) => {
      const [elName, knobKey] = splitNs(key);
      if (!elName || !knobKey) return;
      const idx = elements.findIndex((e) => e.name === elName);
      if (idx < 0) return;
      const childHandle = (handle.userData as unknown as ChildHandles)?.handles?.[idx];
      if (!childHandle) return;
      elements[idx].onKnob?.(childHandle, knobKey, value);
    },
    telemetry: (handle, ctx) => {
      const out: Record<string, unknown> = {};
      const childHandles = (handle.userData as unknown as ChildHandles)?.handles ?? [];
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const h = childHandles[i];
        out[el.name] = h && el.telemetry ? el.telemetry(h, ctx) : {};
      }
      return out;
    },
    motionProbes,
    events: (handle, ctx) => {
      const out: TriscopeEvent[] = [];
      const childHandles = (handle.userData as unknown as ChildHandles)?.handles ?? [];
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const h = childHandles[i];
        if (!el.events || !h) continue;
        try {
          for (const ev of el.events(h, ctx) ?? []) {
            // Namespace event types so a `collision` from ship and water
            // are distinguishable downstream.
            out.push({ ...ev, type: nsKey(el.name, ev.type) });
          }
        } catch {
          /* ignore element-level failures */
        }
      }
      return out;
    },
  };
}

function unionBounds(elements: Element[]): Element['bounds'] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const el of elements) {
    if (!el.bounds) continue;
    any = true;
    for (let i = 0; i < 3; i++) {
      if (el.bounds.min[i] < min[i]) min[i] = el.bounds.min[i];
      if (el.bounds.max[i] > max[i]) max[i] = el.bounds.max[i];
    }
  }
  return any ? { min, max } : undefined;
}

function nsKey(elementName: string, key: string): string {
  return `${elementName}.${key}`;
}

function splitNs(key: string): [string, string] {
  const dot = key.indexOf('.');
  if (dot < 0) return ['', key];
  return [key.slice(0, dot), key.slice(dot + 1)];
}
