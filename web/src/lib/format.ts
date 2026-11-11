/**
 * Compact runs file shared by the ingest script (writer) and the web page (reader).
 *
 * Each path is a flat integer array of triples. The first triple is the start point relative to `ref`,
 * every following triple is the delta to the previous one:
 *   [x0, y0, 0, dx1, dy1, dt1, dx2, dy2, dt2, ...]
 * where x = round((lon - ref[0]) * scale), y = round((lat - ref[1]) * scale), t in whole seconds.
 */
export interface RunRecord {
  id: string;
  name: string;
  date: string;   // ISO start time (UTC)
  dist: number;   // metres of the animated (cleaned) track
  csvDist?: number; // distance Strava reports in activities.csv, metres
  dur: number;    // animated duration in seconds (after pause shortening)
  p: number[];
}

/** A place many runs start from. */
export interface HomeCandidate {
  /** stable id (from the earliest run starting there), independent of the stored coordinates */
  id: string;
  lat: number;
  lon: number;
  runs: number;     // runs that start within meta.radius
  first: number;    // first and last year of those runs
  last: number;
  fromOption?: boolean; // given with --home
}

export interface RunsFile {
  version: 2;
  generatedAt: string;
  scale: number;
  ref: [number, number]; // lon, lat
  meta: {
    /** default start radius for the page, metres */
    radius: number;
    /** true when track ends near every home were trimmed; homes are then rounded to ~1 km */
    privacyTrimmed: boolean;
    /** home candidates, densest first (or the --home one first) */
    homes: HomeCandidate[];
    /** the page lists candidates closer than this (m) to a larger one as nearby start spots */
    homeSpacing: number;
    maxSpeed: number;
    sport: string;
    since: string | null;
    until: string | null;
  };
  runs: RunRecord[];
}

export interface DecodedPath {
  lonlat: Float64Array; // [lon0, lat0, lon1, lat1, ...]
  t: Float32Array;      // seconds since start
}

/** Encode lon/lat/t arrays into the delta format. */
export function encodePath(lon: ArrayLike<number>, lat: ArrayLike<number>, t: ArrayLike<number>,
  ref: [number, number], scale: number): number[] {
  const out: number[] = [];
  let px = 0, py = 0, pt = 0;
  for (let i = 0; i < lon.length; i++) {
    const x = Math.round((lon[i] - ref[0]) * scale);
    const y = Math.round((lat[i] - ref[1]) * scale);
    const tt = Math.round(t[i]);
    out.push(x - px, y - py, tt - pt);
    px = x; py = y; pt = tt;
  }
  return out;
}

export function decodePath(p: ArrayLike<number>, ref: [number, number], scale: number): DecodedPath {
  const n = Math.floor(p.length / 3);
  const lonlat = new Float64Array(n * 2);
  const t = new Float32Array(n);
  let x = 0, y = 0, tt = 0;
  for (let i = 0; i < n; i++) {
    x += p[3 * i]; y += p[3 * i + 1]; tt += p[3 * i + 2];
    lonlat[2 * i] = ref[0] + x / scale;
    lonlat[2 * i + 1] = ref[1] + y / scale;
    t[i] = tt;
  }
  return { lonlat, t };
}
