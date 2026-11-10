import { describe, expect, test } from 'bun:test';
import { endFrameOfClock, frameAt, makeWarp, runTime, totalFrames, type WarpParams } from '../src/lib/timewarp.ts';

// reference values from homeruns/timewarp.py (intro 45, run_frames 900, k 2.3, tmax 5400, ramp 60)
const P: WarpParams = { intro: 45, runFrames: 900, k: 2.3, tmax: 5400, ramp: 60 };
const RUN_TIME: [number, number][] = [
  [0, 0], [45, 0], [60, 1.2627541890426235], [75, 8.712282498101505], [105, 47.946814423001705],
  [300, 467.61973767140756], [600, 1700.125338000732], [900, 4353.191033231022], [975, 5400], [1100, 5400],
];
const FRAME_AT: [number, number][] = [
  [1, 58.82745435761629], [30, 93.67274307869332], [600, 345.6698515655158], [3000, 775.1867324136365], [5400, 975],
];

describe('timewarp', () => {
  test('matches the Python run_time', () => {
    for (const [f, t] of RUN_TIME) expect(runTime(f, P)).toBeCloseTo(t, 9);
  });

  test('matches the Python frame_at', () => {
    for (const [t, f] of FRAME_AT) expect(frameAt(t, P)).toBeCloseTo(f, 6);
  });

  test('clock is stopped during the intro, then monotonic and slow at first', () => {
    let prev = -1;
    for (let f = 0; f <= 1000; f++) {
      const t = runTime(f, P);
      if (f <= P.intro) expect(t).toBe(0);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
    // first second after the intro covers far less run time than the last second
    const early = runTime(P.intro + 60, P) - runTime(P.intro + 30, P);
    const late = runTime(945, P) - runTime(915, P);
    expect(late).toBeGreaterThan(5 * early);
  });

  test('frameAt inverts runTime', () => {
    for (const t of [0.5, 10, 100, 1000, 4000, 5399]) expect(runTime(frameAt(t, P), P)).toBeCloseTo(t, 4);
  });

  test('linear when k = 0 and no ramp', () => {
    const lin = { ...P, k: 0, ramp: 0 };
    expect(runTime(45 + 450, lin)).toBeCloseTo(2700, 9);
    expect(endFrameOfClock(lin)).toBe(945);
  });

  test('makeWarp / totalFrames', () => {
    const w = makeWarp(3600, 30);
    expect(w).toEqual({ intro: 45, runFrames: 900, k: 2.3, tmax: 3600, ramp: 60 });
    expect(totalFrames(w)).toBe(975 + 120);
    expect(runTime(endFrameOfClock(w), w)).toBeCloseTo(3600, 9);
  });
});
