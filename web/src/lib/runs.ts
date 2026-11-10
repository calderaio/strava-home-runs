import { decodePath, type RunsFile } from './format.ts';

export interface Run {
  id: string;
  name: string;
  date: Date;
  day: string;          // YYYY-MM-DD (UTC)
  year: number;
  dist: number;         // metres
  dur: number;          // animated duration, s
  sd: number | null;    // start distance from home, m (null when the file was privacy-trimmed)
  lonlat: Float64Array; // flat [lon, lat, ...]
  t: Float32Array;      // seconds since start
}

export function decodeRuns(file: RunsFile): Run[] {
  if (file.version !== 1 || !Array.isArray(file.runs)) throw new Error('unsupported runs file');
  return file.runs.map((r) => {
    const { lonlat, t } = decodePath(r.p, file.ref, file.scale);
    const date = new Date(r.date);
    return {
      id: r.id, name: r.name, date, day: r.date.slice(0, 10), year: date.getUTCFullYear(),
      dist: r.dist, dur: t.length ? t[t.length - 1] : r.dur, sd: r.sd ?? null, lonlat, t,
    };
  });
}

/** Inclusive date range (YYYY-MM-DD, UTC) and maximum start distance from home in metres. */
export interface Filters { from: string; to: string; maxStart: number }

export function filterRuns(runs: Run[], f: Filters): Run[] {
  return runs.filter((r) => r.day >= f.from && r.day <= f.to && (r.sd === null || r.sd <= f.maxStart) && r.t.length >= 2);
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
