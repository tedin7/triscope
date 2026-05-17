/**
 * Lab UI CSS, exported as a template string so consumers can inject it
 * once via `mountLabDom()` instead of duplicating it in every per-element
 * lab HTML page.
 *
 * Covers: full-bleed canvas, camera-label tags, HUD strip, boot overlay,
 * knob-editor pane. The selectors match the DOM that `mountLabDom()`
 * creates and that `runLab()` / `mountEditor()` populate.
 */
export const LAB_CSS = `
html, body { margin: 0; padding: 0; overflow: hidden; background: #000; color: #cfd6db; font-family: ui-monospace, monospace; }
#app { position: fixed; inset: 0; }
canvas { display: block; width: 100%; height: 100%; }

.triscope-label, .label {
  position: absolute;
  background: rgba(0,0,0,0.55);
  color: #cfd6db;
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  pointer-events: none;
  border-radius: 3px;
  z-index: 5;
}

#hud { position: fixed; bottom: 8px; left: 8px; z-index: 10; font-size: 11px; padding: 4px 8px; background: rgba(0,0,0,0.55); border-radius: 3px; }
#boot { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: #0a1a20; color: #cfd6db; font-size: 14px; z-index: 50; }

#lab-controls {
  position: fixed;
  right: 8px;
  bottom: 8px;
  z-index: 20;
  width: min(320px, calc(100vw - 24px));
  padding: 10px 12px;
  background: rgba(5, 12, 16, 0.78);
  border: 1px solid rgba(210, 230, 240, 0.16);
  border-radius: 6px;
  backdrop-filter: blur(8px);
  box-sizing: border-box;
}
.triscope-editor__row {
  display: grid;
  grid-template-columns: 110px 1fr 56px;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #cfd6db;
  margin: 4px 0;
}
.triscope-editor__row label { font-size: 10px; opacity: 0.85; }
.triscope-editor__row input { width: 100%; accent-color: #8fc7d9; }
.triscope-editor__row output { text-align: right; color: #f0f5f7; }
`;
