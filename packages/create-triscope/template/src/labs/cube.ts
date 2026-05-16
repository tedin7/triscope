import { runLab } from '@triscope/core';
import { cube } from '../elements/cube';

async function boot() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  const boot = document.getElementById('boot');
  const hud = document.getElementById('hud');
  const labels = document.getElementById('app');
  const editor = document.getElementById('lab-controls');
  if (!canvas) return;
  try {
    await runLab({
      element: cube,
      canvas,
      hud,
      labelContainer: labels,
      editorContainer: editor,
      bootOverlay: boot,
    });
  } catch (err: any) {
    if (boot) boot.textContent = `Init failed: ${err?.message ?? err}`;
    console.error(err);
  }
}
boot();
