import { runLab } from '@triscope/core';
import { galleonElement } from './element.js';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const hud = document.getElementById('hud');
const labelContainer = document.getElementById('labels');
const editorContainer = document.getElementById('lab-controls');
const bootOverlay = document.getElementById('boot');

runLab({
  element: galleonElement,
  canvas,
  hud,
  labelContainer,
  editorContainer,
  bootOverlay,
  clearColor: 0x0a1a20,
  captureSize: [1280, 720],
}).catch((err) => {
  console.error('runLab failed', err);
  if (bootOverlay) bootOverlay.textContent = `boot failed: ${err.message ?? err}`;
});
