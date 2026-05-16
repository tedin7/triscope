// Reference photo primitives: save a reference PNG per (element, camera),
// then compose a side-by-side diff against the current view + a scalar
// mean-absolute-difference. Designed so the user can paste an image in chat
// and have Claude pipe it straight into set_reference without an intermediate
// file system dance — both `path` and `base64` inputs are accepted.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PNG } from 'pngjs';

const stripPrefix = (s) => s.replace(/^data:image\/png;base64,/, '');

function refsRoot(cwd) {
  return resolve(cwd, 'refs');
}

export function refsPath(cwd, element, camera) {
  // Sanitize the camera name to a single path segment so any name the
  // element declares can become a filename safely.
  const safeCam = String(camera).replace(/[^A-Za-z0-9._-]/g, '_');
  return join(refsRoot(cwd), element, `${safeCam}.png`);
}

export function setReference({ cwd, element, camera, path, base64 }) {
  if (!element || !camera) throw new Error('element and camera are required');
  let bytes;
  if (path) {
    if (!existsSync(path)) throw new Error(`reference file not found: ${path}`);
    bytes = readFileSync(path);
  } else if (base64) {
    bytes = Buffer.from(stripPrefix(base64), 'base64');
  } else {
    throw new Error('provide either path or base64');
  }
  const dest = refsPath(cwd, element, camera);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
  return { path: dest, bytes: bytes.length };
}

function decodePng(buffer) {
  return PNG.sync.read(buffer);
}

function nearestNeighborResize(src, targetW, targetH) {
  if (src.width === targetW && src.height === targetH) return src;
  const dst = new PNG({ width: targetW, height: targetH });
  for (let y = 0; y < targetH; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / targetH));
    for (let x = 0; x < targetW; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / targetW));
      const si = (sy * src.width + sx) * 4;
      const di = (y * targetW + x) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = 255;
    }
  }
  return dst;
}

function composeSideBySide(left, right) {
  // Match heights to the smaller of the two so we don't grow the payload,
  // then concatenate horizontally with a 4-px black separator.
  const h = Math.min(left.height, right.height);
  const sep = 4;
  const lw = Math.round((left.width * h) / left.height);
  const rw = Math.round((right.width * h) / right.height);
  const w = lw + sep + rw;
  const L = nearestNeighborResize(left, lw, h);
  const R = nearestNeighborResize(right, rw, h);
  const out = new PNG({ width: w, height: h });
  // Fill background black (default is zeros — alpha would be 0; force 255).
  for (let i = 0; i < out.data.length; i += 4) out.data[i + 3] = 255;
  for (let y = 0; y < h; y++) {
    const orow = y * w * 4;
    const lrow = y * lw * 4;
    const rrow = y * rw * 4;
    L.data.copy(out.data, orow, lrow, lrow + lw * 4);
    R.data.copy(out.data, orow + (lw + sep) * 4, rrow, rrow + rw * 4);
  }
  return out;
}

function meanAbsDiff(a, b) {
  // Resize to a common 256x256 grid to keep the metric cheap and
  // resolution-independent.
  const W = 256;
  const H = 256;
  const A = nearestNeighborResize(a, W, H);
  const B = nearestNeighborResize(b, W, H);
  let sum = 0;
  const pixels = W * H * 3;
  for (let i = 0; i < W * H; i++) {
    const j = i * 4;
    sum += Math.abs(A.data[j] - B.data[j]);
    sum += Math.abs(A.data[j + 1] - B.data[j + 1]);
    sum += Math.abs(A.data[j + 2] - B.data[j + 2]);
  }
  return +(sum / pixels).toFixed(2);
}

export function diffReference({ cwd, element, camera, currentBase64 }) {
  const refPath = refsPath(cwd, element, camera);
  if (!existsSync(refPath)) {
    throw new Error(`no reference at ${refPath} — call set_reference first`);
  }
  if (!currentBase64) throw new Error('currentBase64 is required');
  const refPng = decodePng(readFileSync(refPath));
  const curPng = decodePng(Buffer.from(stripPrefix(currentBase64), 'base64'));
  const composite = composeSideBySide(refPng, curPng);
  const compositeBuf = PNG.sync.write(composite);
  const meanAbs = meanAbsDiff(refPng, curPng);
  return {
    camera,
    refPath,
    meanAbsDiff: meanAbs, // 0 = identical, 255 = max possible difference
    compositeBase64: compositeBuf.toString('base64'),
  };
}
