/**
 * Synthetic test data. All coordinates are in the open South Pacific, far from anyone's home.
 */
import { metresPerDegree } from '../ingest/track.ts';
import type { Run } from '../src/lib/runs.ts';

export const HOME: [number, number] = [-20.0, -140.0]; // lat, lon
export const REF: [number, number] = [-140.0, -20.0]; // lon, lat
const [KY, KX] = metresPerDegree(HOME[0]);

/** Point `east` / `north` metres from HOME. [lat, lon] */
export function offset(east: number, north = 0, from: [number, number] = HOME): [number, number] {
  return [from[0] + north / KY, from[1] + east / KX];
}

/** A GPX document with one timed point per entry. */
export function gpx(points: { lat: number; lon: number; t: number }[], type = 'running'): string {
  const pts = points.map((p) => `<trkpt lat="${p.lat}" lon="${p.lon}"><ele>1</ele><time>${new Date(p.t * 1000).toISOString()}</time></trkpt>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="test" version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
 <trk><name>test</name><type>${type}</type><trkseg>
  ${pts.join('\n  ')}
 </trkseg></trk>
</gpx>`;
}

/** Straight run east from `start` at `speed` m/s, one point per second. */
export function line(n: number, t0: number, speed = 3, start: [number, number] = HOME) {
  return Array.from({ length: n }, (_, i) => {
    const [lat, lon] = offset(i * speed, 0, start);
    return { lat, lon, t: t0 + i };
  });
}

/** A decoded run for client-side tests. */
export const run = (lonlat: number[], t: number[], extra: Partial<Run> = {}): Run => ({
  id: 'x', name: 'x', date: new Date(0), day: '2024-05-01', year: 2024, dist: 0, dur: t[t.length - 1], sd: 0,
  lonlat: Float64Array.from(lonlat), t: Float32Array.from(t), ...extra,
});
