/**
 * Track reading and cleaning, ported from homeruns/tracks.py.
 *
 * read: FIT, GPX and TCX, each optionally gzipped -> timed points
 * clean: drop GPS spikes, cut at permanent signal loss, shorten long pauses
 * findHome: densest start cluster
 * hideEnds: privacy trimming around home
 */
import { gunzipSync } from 'node:zlib';
import { isFit, parseFit } from './fit.ts';

/** Raw points as read from a file; `time` is unix seconds. */
export interface RawTrack {
  lat: number[];
  lon: number[];
  time: number[];
  sport: string;
  /** the file ended early or was corrupt; the points read before that are kept */
  truncated?: boolean;
}

/** A track with time relative to its start. */
export interface Track {
  start: number; // unix seconds of the first point
  sport: string;
  lat: Float64Array;
  lon: Float64Array;
  t: Float64Array; // seconds since start
  cut?: boolean;   // set by clean() when the track was cut at a permanent signal loss
}

export const MIN_POINTS = 10;

export function metresPerDegree(lat: number): [number, number] {
  return [110540.0, 111320.0 * Math.cos((lat * Math.PI) / 180)];
}

// ---------------------------------------------------------------- reading

const GZIP = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

export function decompress(buf: Uint8Array): Uint8Array {
  return GZIP(buf) ? new Uint8Array(gunzipSync(buf)) : buf;
}

export function formatOf(name: string): 'fit' | 'gpx' | 'tcx' | null {
  const m = name.toLowerCase().replace(/\.gz$/, '').match(/\.(fit|gpx|tcx)$/);
  return m ? (m[1] as 'fit' | 'gpx' | 'tcx') : null;
}

/** Parse file contents (possibly gzipped). The format is sniffed, with the file name as a hint. */
export function parseTrackBytes(bytes: Uint8Array, name = ''): RawTrack {
  const buf = decompress(bytes);
  if (isFit(buf)) return parseFit(buf);
  const text = new TextDecoder('utf-8').decode(buf);
  const fmt = formatOf(name);
  if (fmt === 'tcx' || (fmt !== 'gpx' && /<(?:[\w-]+:)?TrainingCenterDatabase\b/.test(text))) return parseTcx(text);
  if (fmt === 'gpx' || /<(?:[\w-]+:)?gpx\b/.test(text)) return parseGpx(text);
  throw new Error('unsupported format');
}

function parseTime(s: string): number {
  let v = s.trim();
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(v)) v += 'Z'; // timestamps without zone are taken as UTC
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms / 1000 : NaN;
}

const attr = (attrs: string, name: string) => {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`));
  return m ? parseFloat(m[1]) : NaN;
};

export function parseGpx(text: string): RawTrack {
  const out: RawTrack = { lat: [], lon: [], time: [], sport: '' };
  const type = text.match(/<(?:[\w-]+:)?trk\b[\s\S]*?<(?:[\w-]+:)?type>\s*([^<]*?)\s*<\//);
  if (type) out.sport = type[1].toLowerCase();
  const re = /<(?:[\w-]+:)?trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?trkpt>)/g;
  for (const m of text.matchAll(re)) {
    if (!m[2]) continue;
    const tm = m[2].match(/<(?:[\w-]+:)?time>([^<]+)<\//);
    if (!tm) continue;
    const la = attr(m[1], 'lat');
    const lo = attr(m[1], 'lon');
    const t = parseTime(tm[1]);
    if (Number.isFinite(la) && Number.isFinite(lo) && Number.isFinite(t)) {
      out.lat.push(la); out.lon.push(lo); out.time.push(t);
    }
  }
  return out;
}

export function parseTcx(text: string): RawTrack {
  const out: RawTrack = { lat: [], lon: [], time: [], sport: '' };
  const sp = text.match(/<(?:[\w-]+:)?Activity\b[^>]*\bSport\s*=\s*["']([^"']*)["']/);
  if (sp) out.sport = sp[1].toLowerCase();
  const re = /<(?:[\w-]+:)?Trackpoint\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Trackpoint>/g;
  const val = (s: string, tag: string) => s.match(new RegExp(`<(?:[\\w-]+:)?${tag}>([^<]+)<\\/`))?.[1];
  for (const m of text.matchAll(re)) {
    const tm = val(m[1], 'Time');
    const la = val(m[1], 'LatitudeDegrees');
    const lo = val(m[1], 'LongitudeDegrees');
    if (!tm || !la || !lo) continue;
    const t = parseTime(tm);
    const a = parseFloat(la), b = parseFloat(lo);
    if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(t)) {
      out.lat.push(a); out.lon.push(b); out.time.push(t);
    }
  }
  return out;
}

const MIN_TIME = Date.UTC(2000, 0, 1) / 1000;

/** Relative-time track, or null if it has fewer than MIN_POINTS timed points. */
export function toTrack(raw: RawTrack): Track | null {
  // drop points with unusable timestamps (unset device clocks report 1989/1970) or coordinates
  const idx: number[] = [];
  for (let i = 0; i < raw.lat.length; i++) {
    const t = raw.time[i], la = raw.lat[i], lo = raw.lon[i];
    if (Number.isFinite(t) && t >= MIN_TIME && Math.abs(la) <= 90 && Math.abs(lo) <= 180) idx.push(i);
  }
  if (idx.length < MIN_POINTS) return null;
  const t0 = raw.time[idx[0]];
  return {
    start: t0,
    sport: raw.sport,
    lat: Float64Array.from(idx, (i) => raw.lat[i]),
    lon: Float64Array.from(idx, (i) => raw.lon[i]),
    t: Float64Array.from(idx, (i) => raw.time[i] - t0),
  };
}


// ---------------------------------------------------------------- cleaning

function median(a: ArrayLike<number>): number {
  const s = Float64Array.from(a).sort();
  const n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function pick(tr: Track, idx: number[], t?: Float64Array): Track {
  return {
    start: tr.start,
    sport: tr.sport,
    lat: Float64Array.from(idx, (i) => tr.lat[i]),
    lon: Float64Array.from(idx, (i) => tr.lon[i]),
    t: t ?? Float64Array.from(idx, (i) => tr.t[i]),
  };
}

/**
 * Drop GPS spikes and cap pauses.
 *
 * A point is a spike if reaching it from the last good point needs more than `maxSpeed` m/s
 * (and is more than 50 m away). If `maxRejects` points in a row are spikes, the signal is gone
 * (a tunnel, the metro) and the track is cut at the last good point.
 * Pauses are capped at 3x the median sampling interval so stops don't freeze runners.
 */
export function clean(tr: Track, maxSpeed = 7.0, maxRejects = 10): Track {
  const [ky, kx] = metresPerDegree(tr.lat[0]);
  const keep = [0];
  let rejects = 0;
  let cut = false;
  for (let i = 1; i < tr.t.length; i++) {
    const j = keep[keep.length - 1];
    const dt = tr.t[i] - tr.t[j];
    if (dt <= 0) continue;
    const d = Math.hypot((tr.lat[i] - tr.lat[j]) * ky, (tr.lon[i] - tr.lon[j]) * kx);
    if (d > 50 && d / dt > maxSpeed) {
      rejects++;
      if (rejects >= maxRejects) { cut = true; break; }
      continue;
    }
    rejects = 0;
    keep.push(i);
  }
  const raw = Float64Array.from(keep, (i) => tr.t[i]);
  const dts = new Float64Array(Math.max(raw.length - 1, 0));
  for (let i = 1; i < raw.length; i++) dts[i - 1] = raw[i] - raw[i - 1];
  const cap = 3 * median(dts);
  const t = new Float64Array(raw.length);
  for (let i = 1; i < raw.length; i++) t[i] = t[i - 1] + Math.min(dts[i - 1], cap);
  return { ...pick(tr, keep, t), cut };
}

/** The start point with the most other starts within `radius` metres (mean of that cluster). [lat, lon] */
export function findHome(starts: [number, number][], radius: number): [number, number] {
  const [ky, kx] = metresPerDegree(median(starts.map((s) => s[0])));
  const n = starts.length;
  let best = -1;
  let bestCount = -1;
  for (let i = 0; i < n; i++) {
    let c = 0;
    for (let j = 0; j < n; j++) {
      if (Math.hypot((starts[i][0] - starts[j][0]) * ky, (starts[i][1] - starts[j][1]) * kx) <= radius) c++;
    }
    if (c > bestCount) { bestCount = c; best = i; }
  }
  let sa = 0, sb = 0, c = 0;
  for (let j = 0; j < n; j++) {
    if (Math.hypot((starts[best][0] - starts[j][0]) * ky, (starts[best][1] - starts[j][1]) * kx) <= radius) {
      sa += starts[j][0]; sb += starts[j][1]; c++;
    }
  }
  return [sa / c, sb / c];
}

export interface HomeCluster {
  lat: number;
  lon: number;
  members: number[]; // indices into the starts array
}

/**
 * Every place many runs start from: the densest start cluster (findHome), then the densest among the
 * remaining starts, and so on, while a cluster has at least `minRuns` starts within `radius`.
 */
export function findHomes(starts: [number, number][], radius: number, minRuns: number): HomeCluster[] {
  let remaining = starts.map((_, i) => i);
  const out: HomeCluster[] = [];
  while (remaining.length >= Math.max(1, minRuns)) {
    const [lat, lon] = findHome(remaining.map((i) => starts[i]), radius);
    const members = remaining.filter((i) => distTo(starts[i][0], starts[i][1], [lat, lon]) <= radius);
    if (members.length < Math.max(1, minRuns)) break;
    out.push({ lat, lon, members });
    const taken = new Set(members);
    remaining = remaining.filter((i) => !taken.has(i));
  }
  return out;
}

export function distTo(lat: number, lon: number, home: [number, number]): number {
  const [ky, kx] = metresPerDegree(home[0]);
  return Math.hypot((lat - home[0]) * ky, (lon - home[1]) * kx);
}

/** Remove the start and end of a track inside `radius` metres of home, or of any of several homes (like a privacy zone). */
export function hideEnds(tr: Track, home: [number, number] | [number, number][], radius: number): Track | null {
  const homes = (typeof home[0] === 'number' ? [home] : home) as [number, number][];
  const n = tr.t.length;
  const out = new Array<boolean>(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    out[i] = homes.every((h) => distTo(tr.lat[i], tr.lon[i], h) > radius);
    if (out[i]) count++;
  }
  if (count < MIN_POINTS) return null;
  const a = out.indexOf(true);
  const b = out.lastIndexOf(true) + 1;
  const idx = Array.from({ length: b - a }, (_, k) => a + k);
  const t = Float64Array.from(idx, (i) => tr.t[i] - tr.t[a]);
  return pick(tr, idx, t);
}

/** Keep a point once it is at least `minDt` seconds and `minDist` metres from the last kept one; keep the last point. */
export function downsample(tr: Track, minDt = 5, minDist = 10): Track {
  const n = tr.t.length;
  if (n < 3) return tr;
  const [ky, kx] = metresPerDegree(tr.lat[0]);
  const keep = [0];
  for (let i = 1; i < n - 1; i++) {
    const j = keep[keep.length - 1];
    if (tr.t[i] - tr.t[j] < minDt) continue;
    if (Math.hypot((tr.lat[i] - tr.lat[j]) * ky, (tr.lon[i] - tr.lon[j]) * kx) < minDist) continue;
    keep.push(i);
  }
  keep.push(n - 1);
  return pick(tr, keep);
}

export function pathLength(tr: Track): number {
  const [ky, kx] = metresPerDegree(tr.lat[0]);
  let d = 0;
  for (let i = 1; i < tr.t.length; i++) {
    d += Math.hypot((tr.lat[i] - tr.lat[i - 1]) * ky, (tr.lon[i] - tr.lon[i - 1]) * kx);
  }
  return d;
}
