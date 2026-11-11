import { decodePath, type RunsFile } from './format.ts';

export interface Run {
  id: string;
  name: string;
  date: Date;
  day: string;          // YYYY-MM-DD (UTC)
  year: number;
  dist: number;         // metres
  dur: number;          // animated duration, s
  start: [number, number]; // lon, lat of the first point as stored (already trimmed if the file was)
  lonlat: Float64Array; // flat [lon, lat, ...]
  t: Float32Array;      // seconds since start
}

export interface Home { lat: number; lon: number }

export function decodeRuns(file: RunsFile): Run[] {
  if (file.version !== 2 || !Array.isArray(file.runs)) {
    throw new Error(`unsupported runs file (version ${String(file.version)}; this page reads version 2 — run the ingest again)`);
  }
  return file.runs.map((r) => {
    const { lonlat, t } = decodePath(r.p, file.ref, file.scale);
    const date = new Date(r.date);
    return {
      id: r.id, name: r.name, date, day: r.date.slice(0, 10), year: date.getUTCFullYear(),
      dist: r.dist, dur: t.length ? t[t.length - 1] : r.dur, start: [lonlat[0], lonlat[1]], lonlat, t,
    };
  });
}

/** Metres between a point and home, with the same flat-earth approximation as the ingest. */
export function distToHome(lon: number, lat: number, home: Home): number {
  const kx = 111320 * Math.cos((home.lat * Math.PI) / 180);
  return Math.hypot((lat - home.lat) * 110540, (lon - home.lon) * kx);
}

/** Inclusive date range (YYYY-MM-DD, UTC), the chosen home and the maximum start distance from it (m). */
export interface Filters { from: string; to: string; maxStart: number; home: Home }

export function filterRuns(runs: Run[], f: Filters): Run[] {
  return runs.filter((r) => r.day >= f.from && r.day <= f.to && r.t.length >= 2
    && distToHome(r.start[0], r.start[1], f.home) <= f.maxStart);
}

/** Runs that start within `radius` of home, and their first and last day. */
export function homeRange(runs: Run[], home: Home, radius: number): { count: number; first: string; last: string } {
  let count = 0, first = '', last = '';
  for (const r of runs) {
    if (distToHome(r.start[0], r.start[1], home) > radius) continue;
    count++;
    if (!first || r.day < first) first = r.day;
    if (!last || r.day > last) last = r.day;
  }
  return { count, first, last };
}

/**
 * Privacy trim relative to the chosen home: drop the start and end of the run while it is within
 * `radius` metres of home and restart its clock at the first point outside. Null if fewer than two
 * points are left. A radius of 0 returns the run unchanged.
 */
export function trimAround(r: Run, home: Home, radius: number): Run | null {
  if (radius <= 0) return r;
  const n = r.t.length;
  const outside = (i: number) => distToHome(r.lonlat[2 * i], r.lonlat[2 * i + 1], home) > radius;
  let a = 0;
  while (a < n && !outside(a)) a++;
  let b = n - 1;
  while (b > a && !outside(b)) b--;
  if (b - a + 1 < 2) return null;
  const lonlat = r.lonlat.slice(2 * a, 2 * (b + 1));
  const t0 = r.t[a];
  const t = Float32Array.from(r.t.subarray(a, b + 1), (v) => v - t0);
  return { ...r, lonlat, t, dur: t[t.length - 1], start: [lonlat[0], lonlat[1]] };
}

/** Position [lon, lat] of a run at clock time `clock`, or null once it has finished. */
export function headAt(r: Run, clock: number): [number, number] | null {
  const t = r.t;
  const n = t.length;
  if (clock >= t[n - 1]) return null;
  if (clock <= 0) return [r.lonlat[0], r.lonlat[1]];
  let lo = 0, hi = n - 1; // t[lo] <= clock < t[hi]
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (t[m] <= clock) lo = m; else hi = m;
  }
  const a = (clock - t[lo]) / (t[hi] - t[lo] || 1);
  const L = r.lonlat;
  return [L[2 * lo] + a * (L[2 * hi] - L[2 * lo]), L[2 * lo + 1] + a * (L[2 * hi + 1] - L[2 * lo + 1])];
}
