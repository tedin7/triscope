/**
 * Lab DOM scaffolding helper.
 *
 * Eliminates per-project boilerplate: instead of every lab HTML page
 * declaring its own <canvas>, <div id="boot">, <div id="hud">, knob
 * editor pane + the supporting CSS, consumers call
 *
 *   const dom = mountLabDom();
 *   runLab({ element, ...dom });
 *
 * The helper:
 *  - Injects `LAB_CSS` once into `<head>` (no-op on second call).
 *  - Creates the standard ids `runLab()` / `mountEditor()` expect:
 *    `boot`, `app`, `canvas`, `hud`, `lab-controls`.
 *  - Returns the ref bundle in the shape `runLab()` accepts.
 *
 * Existing DOM nodes with matching ids are reused (no duplication).
 * This means a project that wants custom CSS for one element can still
 * hand-write the HTML and skip this helper — the contract is unchanged.
 */
import { LAB_CSS } from './css.js';

export interface LabDomRefs {
  canvas: HTMLCanvasElement;
  hud: HTMLElement;
  boot: HTMLElement;
  labelContainer: HTMLElement;
  editorContainer: HTMLElement;
}

const STYLE_ID = 'triscope-lab-css';

function ensureStyleInjected(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = LAB_CSS;
  document.head.appendChild(style);
}

function getOrCreate<T extends HTMLElement>(id: string, tag: string, parent: HTMLElement): T {
  const existing = document.getElementById(id) as T | null;
  if (existing) return existing;
  const el = document.createElement(tag) as T;
  el.id = id;
  parent.appendChild(el);
  return el;
}

/**
 * Build (or reuse) the standard lab DOM and return the refs `runLab()`
 * needs. Idempotent: calling twice does not duplicate nodes.
 */
export function mountLabDom(): LabDomRefs {
  if (typeof document === 'undefined') {
    throw new Error('mountLabDom() requires a browser DOM (document).');
  }
  ensureStyleInjected();

  const body = document.body;
  const boot = getOrCreate<HTMLDivElement>('boot', 'div', body);
  if (!boot.textContent) boot.textContent = 'Initialising Triscope · WebGPU...';

  const app = getOrCreate<HTMLDivElement>('app', 'div', body);

  // Canvas lives inside `#app` so the label-overlay positioning math in
  // `runLab` (which is relative to `#app`) lines up with the canvas pixels.
  let canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'canvas';
    app.appendChild(canvas);
  }

  const hud = getOrCreate<HTMLDivElement>('hud', 'div', body);
  if (!hud.textContent) hud.textContent = '- fps · WebGPU';

  const editorContainer = getOrCreate<HTMLDivElement>('lab-controls', 'div', body);

  return {
    canvas,
    hud,
    boot,
    labelContainer: app,
    editorContainer,
  };
}
