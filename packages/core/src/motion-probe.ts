/**
 * Ring-buffered numeric probe used by the lab harness to summarize animated
 * Element state without ever leaving the CPU (no GPU readback). The buffer
 * holds the last `capacity` (sample, time) pairs; `stats()` returns aggregates
 * including a zero-crossing-based estimate of dominant frequency.
 *
 * Extracted from `runLab` so the math is unit-testable in isolation.
 */

export interface ProbeStats {
  latest: number;
  mean: number;
  min: number;
  max: number;
  peakToPeak: number;
  zeroCrossingsPerSec: number;
  dominantFreqHz: number;
  /** Last up-to-32 samples, in temporal order. */
  samples: number[];
}

export class MotionProbeBuffer {
  private readonly cap: number;
  private readonly buf: Float32Array;
  private readonly times: Float32Array;
  private writeIdx = 0;
  private count = 0;

  constructor(capacity = 120) {
    if (capacity <= 0) throw new Error('MotionProbeBuffer capacity must be > 0');
    this.cap = capacity;
    this.buf = new Float32Array(capacity);
    this.times = new Float32Array(capacity);
  }

  push(value: number, time: number): void {
    this.buf[this.writeIdx] = value;
    this.times[this.writeIdx] = time;
    this.writeIdx = (this.writeIdx + 1) % this.cap;
    if (this.count < this.cap) this.count += 1;
  }

  get size(): number {
    return this.count;
  }

  get capacity(): number {
    return this.cap;
  }

  /** Returns (samples, times) in temporal order: oldest first, newest last. */
  ordered(): { samples: number[]; times: number[] } {
    const n = this.count;
    const samples: number[] = new Array(n);
    const times: number[] = new Array(n);
    if (n < this.cap) {
      for (let i = 0; i < n; i++) {
        samples[i] = this.buf[i];
        times[i] = this.times[i];
      }
    } else {
      for (let i = 0; i < this.cap; i++) {
        const j = (this.writeIdx + i) % this.cap;
        samples[i] = this.buf[j];
        times[i] = this.times[j];
      }
    }
    return { samples, times };
  }

  stats(): ProbeStats | null {
    if (this.count === 0) return null;
    const { samples, times } = this.ordered();
    return computeProbeStats(samples, times);
  }
}

/**
 * Pure stats kernel. `samples` and `times` must be the same length and in
 * temporal order (oldest first). `times` is in seconds.
 *
 * Frequency estimate: count sign changes of (sample - mean); each full cycle
 * has two zero-crossings, so divide by 2 to get cycles per duration, then by
 * duration to get Hz. Robust for clean sinusoids; not a substitute for FFT on
 * noisy / multi-frequency signals.
 */
export function computeProbeStats(samples: number[], times: number[]): ProbeStats | null {
  const n = samples.length;
  if (n === 0) return null;
  if (times.length !== n) {
    throw new Error(
      `computeProbeStats: samples (${n}) and times (${times.length}) length mismatch`,
    );
  }
  let min = samples[0];
  let max = samples[0];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / n;
  // Sign-based crossing counter. Samples sitting exactly on the mean (within
  // ZERO_EPS) carry the previous sign forward instead of triggering a false
  // crossing — important because sinusoids sampled at frame-aligned times
  // routinely produce values like sin(π) ≈ 1.2e-16 that confuse a strict
  // <=0 / >=0 comparator.
  const ZERO_EPS = 1e-9;
  let crossings = 0;
  let prevSign = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i] - mean;
    const s = Math.abs(v) < ZERO_EPS ? 0 : v > 0 ? 1 : -1;
    if (s !== 0) {
      if (prevSign !== 0 && s !== prevSign) crossings += 1;
      prevSign = s;
    }
  }
  const duration = Math.max(times[n - 1] - times[0], 1e-6);
  const dominantFreqHz = crossings / 2 / duration;
  const zeroCrossingsPerSec = crossings / duration;
  const tail = samples.slice(Math.max(0, n - 32));
  return {
    latest: samples[n - 1],
    mean: +mean.toFixed(4),
    min: +min.toFixed(4),
    max: +max.toFixed(4),
    peakToPeak: +(max - min).toFixed(4),
    zeroCrossingsPerSec: +zeroCrossingsPerSec.toFixed(2),
    dominantFreqHz: +dominantFreqHz.toFixed(2),
    samples: tail,
  };
}
