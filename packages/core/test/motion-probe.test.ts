import { describe, expect, it } from 'vitest';
import { computeProbeStats, MotionProbeBuffer } from '../src/motion-probe.js';

const FPS = 60;
const DT = 1 / FPS;

// Default phase π/4 so zero-crossings fall BETWEEN samples instead of ON them.
// Sample-aligned crossings are a degenerate case (sin(kπ) ≈ 1e-16) that exposes
// truncation artifacts unrelated to the algorithm's normal accuracy.
function sineSamples(
  hz: number,
  durationSec: number,
  amp = 1,
  phase = Math.PI / 4,
): { samples: number[]; times: number[] } {
  const n = Math.round(durationSec * FPS);
  const samples = new Array<number>(n);
  const times = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const t = i * DT;
    times[i] = t;
    samples[i] = amp * Math.sin(2 * Math.PI * hz * t + phase);
  }
  return { samples, times };
}

describe('computeProbeStats', () => {
  it('returns null on empty input', () => {
    expect(computeProbeStats([], [])).toBeNull();
  });

  it('throws on length mismatch', () => {
    expect(() => computeProbeStats([1, 2], [0])).toThrow(/length mismatch/);
  });

  it('reports correct min/max/mean/peakToPeak for known sinusoid', () => {
    const { samples, times } = sineSamples(2, 1);
    const stats = computeProbeStats(samples, times)!;
    expect(stats).not.toBeNull();
    // Mean of a full-cycle sin ~ 0.
    expect(Math.abs(stats.mean)).toBeLessThan(0.05);
    expect(stats.min).toBeGreaterThan(-1.01);
    expect(stats.min).toBeLessThan(-0.95);
    expect(stats.max).toBeGreaterThan(0.95);
    expect(stats.max).toBeLessThan(1.01);
    expect(stats.peakToPeak).toBeGreaterThan(1.95);
    expect(stats.peakToPeak).toBeLessThanOrEqual(2.0);
  });

  it('estimates dominantFreqHz within 5% of true frequency', () => {
    for (const hz of [1, 2, 3, 5, 10]) {
      const { samples, times } = sineSamples(hz, 2);
      const stats = computeProbeStats(samples, times)!;
      const error = Math.abs(stats.dominantFreqHz - hz) / hz;
      expect(error, `hz=${hz} got ${stats.dominantFreqHz}`).toBeLessThan(0.05);
    }
  });

  it('zeroCrossingsPerSec is ~2 × dominantFreqHz', () => {
    const { samples, times } = sineSamples(3, 2);
    const stats = computeProbeStats(samples, times)!;
    expect(stats.zeroCrossingsPerSec / stats.dominantFreqHz).toBeCloseTo(2, 1);
  });

  it('latest returns the last sample', () => {
    const samples = [10, 20, 30];
    const times = [0, 1, 2];
    const stats = computeProbeStats(samples, times)!;
    expect(stats.latest).toBe(30);
  });

  it('samples tail caps at 32', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i);
    const times = Array.from({ length: 100 }, (_, i) => i * DT);
    const stats = computeProbeStats(samples, times)!;
    expect(stats.samples.length).toBe(32);
    expect(stats.samples[0]).toBe(68);
    expect(stats.samples[31]).toBe(99);
  });

  it('constant signal reports zero frequency and zero peakToPeak', () => {
    const samples = Array.from({ length: 60 }, () => 0.5);
    const times = Array.from({ length: 60 }, (_, i) => i * DT);
    const stats = computeProbeStats(samples, times)!;
    expect(stats.peakToPeak).toBe(0);
    expect(stats.dominantFreqHz).toBe(0);
    expect(stats.zeroCrossingsPerSec).toBe(0);
  });
});

describe('MotionProbeBuffer', () => {
  it('starts empty', () => {
    const b = new MotionProbeBuffer(10);
    expect(b.size).toBe(0);
    expect(b.stats()).toBeNull();
  });

  it('rejects non-positive capacity', () => {
    expect(() => new MotionProbeBuffer(0)).toThrow();
    expect(() => new MotionProbeBuffer(-1)).toThrow();
  });

  it('grows up to capacity then stops growing', () => {
    const b = new MotionProbeBuffer(5);
    for (let i = 0; i < 10; i++) b.push(i, i * DT);
    expect(b.size).toBe(5);
    expect(b.capacity).toBe(5);
  });

  it('ordered() returns samples in temporal order when full (oldest first)', () => {
    const b = new MotionProbeBuffer(4);
    for (let i = 0; i < 7; i++) b.push(i * 10, i);
    // pushed: 0,10,20,30,40,50,60 — only last 4 survive: 30,40,50,60
    const { samples, times } = b.ordered();
    expect(samples).toEqual([30, 40, 50, 60]);
    expect(times).toEqual([3, 4, 5, 6]);
  });

  it('ordered() works mid-fill (count < capacity)', () => {
    const b = new MotionProbeBuffer(10);
    b.push(1, 0.1);
    b.push(2, 0.2);
    b.push(3, 0.3);
    const { samples, times } = b.ordered();
    expect(samples).toEqual([1, 2, 3]);
    expect(times.map((t) => +t.toFixed(2))).toEqual([0.1, 0.2, 0.3]);
  });

  it('feeds a 2 Hz sinusoid through the buffer and recovers freq', () => {
    const b = new MotionProbeBuffer(120);
    const { samples, times } = sineSamples(2, 2); // 120 samples, exactly fills the buffer
    for (let i = 0; i < samples.length; i++) b.push(samples[i], times[i]);
    const stats = b.stats()!;
    expect(stats).not.toBeNull();
    expect(Math.abs(stats.dominantFreqHz - 2)).toBeLessThan(0.1);
    expect(stats.peakToPeak).toBeGreaterThan(1.9);
  });

  it('latest reflects the most recent pushed value after wrap-around', () => {
    const b = new MotionProbeBuffer(3);
    for (let i = 0; i < 100; i++) b.push(i, i * DT);
    const stats = b.stats()!;
    expect(stats.latest).toBe(99);
  });
});
