/**
 * Camera track: for every frame, the closest Web Mercator view in which everything drawn so far fits
 * inside the clear band between the title and the clock. Zoom only ever goes out, and both zoom and
 * centre are smoothed with forward-looking averages so the camera is already wide when a route arrives.
 */
import type { Run } from './runs.ts';

export interface ViewBox {
  width: number;   // CSS px of the map
  height: number;
  pad: { top: number; bottom: number; left: number; right: number };
}

export interface CameraTrack {
  lon: Float64Array;
  lat: Float64Array;
  zoom: Float64Array;
}

export interface CameraOptions {
  minSpan: number;  // metres; the opening view is at least this wide
  margin: number;   // extra fraction around the bounds
  maxZoom: number;
  smooth: number;   // frames of forward averaging (applied twice)
}

const TILE = 512;
const CIRCUMFERENCE = 40075016.686;

export const mercX = (lon: number) => (lon + 180) / 360;
export const mercY = (lat: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const lonOf = (x: number) => x * 360 - 180;
const latOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

/** First index i with a[i] >= v (a non-decreasing). */
export function lowerBound(a: ArrayLike<number>, v: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < v) lo = m + 1; else hi = m;
  }
  return lo;
}

function forwardMean(a: Float64Array, w: number): Float64Array {
  const n = a.length;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + a[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = Math.min(n, i + w + 1);
    out[i] = (pre[j] - pre[i]) / (j - i);
  }
  return out;
}

/** `clock[f]` is the run clock (s) at frame f, non-decreasing. */
export function computeCameraTrack(runs: Run[], clock: Float64Array, view: ViewBox,
  opt: CameraOptions = { minSpan: 900, margin: 0.06, maxZoom: 16, smooth: 40 }): CameraTrack {
  const F = clock.length;
  const minX = new Float64Array(F).fill(Infinity);
  const maxX = new Float64Array(F).fill(-Infinity);
  const minY = new Float64Array(F).fill(Infinity);
  const maxY = new Float64Array(F).fill(-Infinity);
  let latSum = 0, latN = 0;
  for (const r of runs) {
    for (let i = 0; i < r.t.length; i++) {
      const f = Math.min(lowerBound(clock, r.t[i]), F - 1);
      const x = mercX(r.lonlat[2 * i]);
      const y = mercY(r.lonlat[2 * i + 1]);
      if (x < minX[f]) minX[f] = x;
      if (x > maxX[f]) maxX[f] = x;
      if (y < minY[f]) minY[f] = y;
      if (y > maxY[f]) maxY[f] = y;
    }
    latSum += r.lonlat[1]; latN++;
  }
  for (let f = 1; f < F; f++) {
    minX[f] = Math.min(minX[f], minX[f - 1]); maxX[f] = Math.max(maxX[f], maxX[f - 1]);
    minY[f] = Math.min(minY[f], minY[f - 1]); maxY[f] = Math.max(maxY[f], maxY[f - 1]);
  }
  const lat0 = latN ? latSum / latN : 0;
  const minSpan = opt.minSpan / (CIRCUMFERENCE * Math.cos((lat0 * Math.PI) / 180));
  const availW = Math.max(1, view.width - view.pad.left - view.pad.right);
  const availH = Math.max(1, view.height - view.pad.top - view.pad.bottom);

  const z = new Float64Array(F);
  const cx = new Float64Array(F);
  const cy = new Float64Array(F);
  for (let f = 0; f < F; f++) {
    if (!Number.isFinite(minX[f])) { z[f] = opt.maxZoom; cx[f] = 0.5; cy[f] = 0.5; continue; }
    const w = Math.max(maxX[f] - minX[f], minSpan) * (1 + 2 * opt.margin);
    const h = Math.max(maxY[f] - minY[f], minSpan) * (1 + 2 * opt.margin);
    const req = Math.log2(Math.min(availW / (w * TILE), availH / (h * TILE)));
    z[f] = Math.min(opt.maxZoom, req, f > 0 ? z[f - 1] : Infinity);
    cx[f] = (minX[f] + maxX[f]) / 2;
    cy[f] = (minY[f] + maxY[f]) / 2;
  }
  const zs = forwardMean(forwardMean(z, opt.smooth), opt.smooth);
  const xs = forwardMean(forwardMean(cx, opt.smooth), opt.smooth);
  const ys = forwardMean(forwardMean(cy, opt.smooth), opt.smooth);

  // the band centre is offset from the canvas centre; shift the map centre so the bounds sit in the band
  const offX = view.pad.left + availW / 2 - view.width / 2;
  const offY = view.pad.top + availH / 2 - view.height / 2;
  const out: CameraTrack = { lon: new Float64Array(F), lat: new Float64Array(F), zoom: zs };
  for (let f = 0; f < F; f++) {
    const world = TILE * 2 ** zs[f];
    out.lon[f] = lonOf(xs[f] - offX / world);
    out.lat[f] = latOf(ys[f] - offY / world);
  }
  return out;
}

export function cameraAt(c: CameraTrack, f: number): { center: [number, number]; zoom: number } {
  const n = c.zoom.length;
  const x = Math.min(Math.max(f, 0), n - 1);
  const i = Math.floor(x);
  const j = Math.min(i + 1, n - 1);
  const a = x - i;
  return {
    center: [c.lon[i] + a * (c.lon[j] - c.lon[i]), c.lat[i] + a * (c.lat[j] - c.lat[i])],
    zoom: c.zoom[i] + a * (c.zoom[j] - c.zoom[i]),
  };
}
