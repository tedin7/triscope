// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mountLabDom } from '../src/lab/dom.js';
import { LAB_CSS } from '../src/lab/css.js';

function resetDom() {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
}

describe('LAB_CSS', () => {
  it('is a non-empty string containing the documented selectors', () => {
    expect(LAB_CSS).toMatch(/\bcanvas\b/);
    expect(LAB_CSS).toMatch(/#boot/);
    expect(LAB_CSS).toMatch(/#hud/);
    expect(LAB_CSS).toMatch(/#lab-controls/);
    expect(LAB_CSS).toMatch(/triscope-editor__row/);
    expect(LAB_CSS).toMatch(/triscope-label/);
  });
});

describe('mountLabDom', () => {
  afterEach(resetDom);

  it('creates the expected node ids and returns the ref bundle', () => {
    const refs = mountLabDom();
    expect(document.getElementById('boot')).toBe(refs.boot);
    expect(document.getElementById('app')).toBe(refs.labelContainer);
    expect(document.getElementById('canvas')).toBe(refs.canvas);
    expect(document.getElementById('hud')).toBe(refs.hud);
    expect(document.getElementById('lab-controls')).toBe(refs.editorContainer);
    expect(refs.canvas.tagName).toBe('CANVAS');
  });

  it('injects LAB_CSS exactly once across multiple calls', () => {
    mountLabDom();
    mountLabDom();
    mountLabDom();
    const styles = document.head.querySelectorAll('style#triscope-lab-css');
    expect(styles.length).toBe(1);
    expect(styles[0].textContent).toBe(LAB_CSS);
  });

  it('reuses existing DOM nodes when matching ids already exist', () => {
    const existingCanvas = document.createElement('canvas');
    existingCanvas.id = 'canvas';
    document.body.appendChild(existingCanvas);
    const existingHud = document.createElement('div');
    existingHud.id = 'hud';
    existingHud.textContent = 'preset hud';
    document.body.appendChild(existingHud);

    const refs = mountLabDom();
    expect(refs.canvas).toBe(existingCanvas);
    expect(refs.hud).toBe(existingHud);
    expect(refs.hud.textContent).toBe('preset hud');
  });

  it('seeds default text on boot and hud only when empty', () => {
    const refs = mountLabDom();
    expect(refs.boot.textContent).toMatch(/Initialising Triscope/);
    expect(refs.hud.textContent).toMatch(/fps/);
  });

  it('parents the canvas inside #app', () => {
    const refs = mountLabDom();
    expect(refs.canvas.parentElement).toBe(refs.labelContainer);
  });

  it('throws when document is missing', async () => {
    // Re-import in a synthetic Node env. We can't truly delete `document`
    // in jsdom, but we can mock-stub the function path through Node's
    // typeof check by deleting the global temporarily.
    const origDoc = globalThis.document;
    // @ts-expect-error force-remove
    delete (globalThis as any).document;
    try {
      expect(() => mountLabDom()).toThrow(/browser DOM/);
    } finally {
      (globalThis as any).document = origDoc;
    }
  });
});
