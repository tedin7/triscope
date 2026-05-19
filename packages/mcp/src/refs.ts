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

export function refsMotionPaths(cwd, element, camera) {
  const safeCam = String(camera).replace(/[^A-Za-z0-9._-]/g, '_');
  const base = join(refsRoot(cwd), element);
  return {
    filmstrip: join(base, `${safeCam}.motion.png`),
    meta: join(base, `${safeCam}.motion.json`),
  };
}

export function setReference({
  cwd,
  element,
  camera,
  path,
  base64,
}: {
  cwd: string;
  element: string;
  camera: string;
  path?: string;
  base64?: string;
}) {
  if (!element || !camera) throw new Error('element and camera are required');
  let bytes: Buffer;
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

export function decodePng(buffer) {
  return PNG.sync.read(buffer);
}

export function nearestNeighborResize(src, targetW, targetH) {
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

export function composeSideBySide(left, right) {
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

export function meanAbsDiff(a, b) {
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

/**
 * Mean Structural Similarity Index (SSIM) — perceptual metric that's
 * robust to mild brightness/contrast shifts and sensitive to structural
 * change. Returns a value in [-1, 1] where 1 = identical, 0 = no
 * correlation, negative = inverse. Most natural-image diffs land in
 * [0.5, 1.0]; below ~0.9 starts to look visibly different.
 *
 * We compute it over Rec.709 luminance on a 256×256 downsample (same as
 * meanAbsDiff for comparability), with non-overlapping 8×8 windows. The
 * three terms are luminance, contrast, and structure with the standard
 * stability constants K1=0.01, K2=0.03 against dynamic range L=255.
 *
 * This is the metric auto_tune optimizes against — meanAbsDiff is too
 * noisy for an optimizer (chases pixel-level glitter), SSIM tracks the
 * actual structure of what the human sees.
 */
export function ssim(a, b): number {
  const W = 256;
  const H = 256;
  const A = nearestNeighborResize(a, W, H);
  const B = nearestNeighborResize(b, W, H);
  const lumA = new Float32Array(W * H);
  const lumB = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const j = i * 4;
    lumA[i] = 0.2126 * A.data[j] + 0.7152 * A.data[j + 1] + 0.0722 * A.data[j + 2];
    lumB[i] = 0.2126 * B.data[j] + 0.7152 * B.data[j + 1] + 0.0722 * B.data[j + 2];
  }
  const L = 255;
  const C1 = (0.01 * L) ** 2;
  const C2 = (0.03 * L) ** 2;
  const WIN = 8;
  let total = 0;
  let count = 0;
  for (let wy = 0; wy < H; wy += WIN) {
    for (let wx = 0; wx < W; wx += WIN) {
      let muA = 0,
        muB = 0;
      for (let dy = 0; dy < WIN; dy++)
        for (let dx = 0; dx < WIN; dx++) {
          const i = (wy + dy) * W + (wx + dx);
          muA += lumA[i];
          muB += lumB[i];
        }
      muA /= WIN * WIN;
      muB /= WIN * WIN;
      let varA = 0,
        varB = 0,
        covAB = 0;
      for (let dy = 0; dy < WIN; dy++)
        for (let dx = 0; dx < WIN; dx++) {
          const i = (wy + dy) * W + (wx + dx);
          const da = lumA[i] - muA;
          const db = lumB[i] - muB;
          varA += da * da;
          varB += db * db;
          covAB += da * db;
        }
      varA /= WIN * WIN - 1;
      varB /= WIN * WIN - 1;
      covAB /= WIN * WIN - 1;
      const num = (2 * muA * muB + C1) * (2 * covAB + C2);
      const den = (muA * muA + muB * muB + C1) * (varA + varB + C2);
      total += num / den;
      count += 1;
    }
  }
  return +(total / count).toFixed(4);
}

export function composeFilmstrip(frameBase64s: string[], opts: { sep?: number } = {}): Buffer {
  // Tile N frames horizontally with a 2-px black separator. Each frame is
  // resized to match the smallest source height (so payload stays bounded
  // even if frames are e.g. 1600x900 each). Returns a PNG Buffer.
  if (!Array.isArray(frameBase64s) || frameBase64s.length === 0) {
    throw new Error('composeFilmstrip: no frames');
  }
  const sep = opts.sep ?? 2;
  const frames = frameBase64s.map((b) => decodePng(Buffer.from(stripPrefix(b), 'base64')));
  const h = Math.min(...frames.map((f) => f.height));
  const resized = frames.map((f) =>
    nearestNeighborResize(f, Math.round((f.width * h) / f.height), h),
  );
  const totalW = resized.reduce((acc, f, i) => acc + f.width + (i > 0 ? sep : 0), 0);
  const out = new PNG({ width: totalW, height: h });
  for (let i = 0; i < out.data.length; i += 4) out.data[i + 3] = 255;
  let x = 0;
  for (let f = 0; f < resized.length; f++) {
    const img = resized[f];
    for (let y = 0; y < h; y++) {
      const srcRow = y * img.width * 4;
      const dstRow = (y * totalW + x) * 4;
      img.data.copy(out.data, dstRow, srcRow, srcRow + img.width * 4);
    }
    x += img.width + sep;
  }
  return PNG.sync.write(out);
}

export function motionMagnitudeFromFrames(frameBase64s) {
  // Mean over consecutive-frame pairs of meanAbsDiff. 256x256 downscale.
  // 0 = no motion; >5 = visible; >20 = vigorous.
  if (!Array.isArray(frameBase64s) || frameBase64s.length < 2) return 0;
  const decoded = frameBase64s.map((b) => decodePng(Buffer.from(stripPrefix(b), 'base64')));
  let total = 0;
  for (let i = 1; i < decoded.length; i++) {
    total += meanAbsDiff(decoded[i - 1], decoded[i]);
  }
  return +(total / (decoded.length - 1)).toFixed(2);
}

export function setReferenceMotion({ cwd, element, camera, frameBase64s, meta }) {
  if (!Array.isArray(frameBase64s) || frameBase64s.length < 2) {
    throw new Error('setReferenceMotion: need at least 2 frames');
  }
  const filmstrip = composeFilmstrip(frameBase64s);
  const { filmstrip: fpath, meta: mpath } = refsMotionPaths(cwd, element, camera);
  mkdirSync(dirname(fpath), { recursive: true });
  writeFileSync(fpath, filmstrip);
  writeFileSync(
    mpath,
    JSON.stringify(
      {
        frames: frameBase64s.length,
        ...meta,
        savedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  return { filmstripPath: fpath, metaPath: mpath, frames: frameBase64s.length };
}

export function diffReferenceMotion({ cwd, element, camera, currentFrames }) {
  const { filmstrip: fpath, meta: mpath } = refsMotionPaths(cwd, element, camera);
  if (!existsSync(fpath)) {
    throw new Error(`no motion reference at ${fpath} — call set_reference_motion first`);
  }
  if (!Array.isArray(currentFrames) || currentFrames.length === 0) {
    throw new Error('currentFrames must be a non-empty array of base64 PNGs');
  }
  const refFilmstrip = decodePng(readFileSync(fpath));
  const curFilmstrip = decodePng(composeFilmstrip(currentFrames));
  // Stack vertically: reference on top, current on bottom, 4-px separator.
  const h = Math.min(refFilmstrip.height, curFilmstrip.height);
  const lw = Math.round((refFilmstrip.width * h) / refFilmstrip.height);
  const rw = Math.round((curFilmstrip.width * h) / curFilmstrip.height);
  const w = Math.max(lw, rw);
  const sep = 4;
  const composite = new PNG({ width: w, height: h * 2 + sep });
  for (let i = 0; i < composite.data.length; i += 4) composite.data[i + 3] = 255;
  const refResized = nearestNeighborResize(refFilmstrip, w, h);
  const curResized = nearestNeighborResize(curFilmstrip, w, h);
  for (let y = 0; y < h; y++) {
    refResized.data.copy(composite.data, y * w * 4, y * w * 4, (y + 1) * w * 4);
    curResized.data.copy(composite.data, (y + h + sep) * w * 4, y * w * 4, (y + 1) * w * 4);
  }
  // Per-frame mean abs diff if we have a saved frame count to align with.
  let meta = null;
  try {
    meta = existsSync(mpath) ? JSON.parse(readFileSync(mpath, 'utf8')) : null;
  } catch {
    /* tolerate corrupt meta */
  }
  const motionDiff = meanAbsDiff(refFilmstrip, curFilmstrip);
  return {
    refFilmstripPath: fpath,
    refMeta: meta,
    motionDiff,
    compositeBase64: PNG.sync.write(composite).toString('base64'),
  };
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
  const ssimScore = ssim(refPng, curPng);
  return {
    camera,
    refPath,
    meanAbsDiff: meanAbs, // 0 = identical, 255 = max difference
    ssim: ssimScore, // 1 = identical, lower = more different
    compositeBase64: compositeBuf.toString('base64'),
  };
}
