/**
 * Frame <-> run-clock mapping, ported from homeruns/timewarp.py.
 *
 * The clock is stopped until `intro`, accelerates from zero over `ramp` frames (smoothstep speed),
 * then follows an exponential curve (k > 0 starts slow, ends fast; k = 0 is linear) that reaches the
 * longest run's duration `ramp / 2` frames after `intro + runFrames`.
 */
export interface WarpParams {
  intro: number;      // frames the clock stays at 0
  runFrames: number;  // frames of (effective) clock movement until tmax
  k: number;          // exponential curvature
  tmax: number;       // longest run duration, seconds
  ramp: number;       // frames of ease-in from standstill
}

export const FPS = 30;
export const INTRO = 45;
export const OUTRO = 120;
export const RAMP = 60;
export const TIME_K = 2.3;

/** Effective frames elapsed (0 .. runFrames), easing in from standstill. */
function progress(f: number, intro: number, runFrames: number, ramp: number): number {
  const x = f - intro;
  if (x <= 0) return 0;
  let g: number;
  if (ramp > 0 && x < ramp) {
    const s = x / ramp;
    g = ramp * (s ** 3 - s ** 4 / 2); // integral of smoothstep speed
  } else {
    g = ramp > 0 ? x - ramp / 2 : x;
  }
  return Math.min(g, runFrames);
}

export function runTime(f: number, p: WarpParams): number {
  const u = progress(f, p.intro, p.runFrames, p.ramp) / p.runFrames;
  return p.tmax * (p.k === 0 ? u : (Math.exp(p.k * u) - 1) / (Math.exp(p.k) - 1));
}

/** Inverse of runTime (first frame at which the clock reaches t). */
export function frameAt(t: number, p: WarpParams): number {
  const y = Math.min(Math.max(t / p.tmax, 0), 1);
  const u = p.k === 0 ? y : Math.log(1 + y * (Math.exp(p.k) - 1)) / p.k;
  const g = u * p.runFrames;
  if (p.ramp > 0 && g < p.ramp / 2) {
    // inside the ease-in: solve s^3 - s^4/2 = g/ramp
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 50; i++) {
      const m = (lo + hi) / 2;
      if (p.ramp * (m ** 3 - m ** 4 / 2) < g) lo = m;
      else hi = m;
    }
    return p.intro + hi * p.ramp;
  }
  return p.intro + g + (p.ramp > 0 ? p.ramp / 2 : 0);
}

export function endFrameOfClock(p: Pick<WarpParams, 'intro' | 'runFrames' | 'ramp'>): number {
  return p.intro + p.runFrames + (p.ramp > 0 ? p.ramp / 2 : 0);
}

/** Default warp for a set of runs: `seconds` of video until the longest run finishes. */
export function makeWarp(tmax: number, seconds: number, fps = FPS): WarpParams {
  const k = fps / FPS; // scale frame-based constants if a different fps is used
  return {
    intro: INTRO * k,
    runFrames: Math.max(1, Math.round(seconds * fps)),
    k: TIME_K,
    tmax: Math.max(tmax, 1),
    ramp: RAMP * k,
  };
}

/** Total frame count including the outro hold. */
export function totalFrames(p: WarpParams, fps = FPS): number {
  return Math.ceil(endFrameOfClock(p)) + Math.round(OUTRO * (fps / FPS));
}
