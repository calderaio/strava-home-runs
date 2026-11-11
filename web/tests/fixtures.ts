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
  id: 'x', name: 'x', date: new Date(0), day: '2024-05-01', year: 2024, dist: 0, dur: t[t.length - 1],
  start: [lonlat[0], lonlat[1]], lonlat: Float64Array.from(lonlat), t: Float32Array.from(t), ...extra,
});

// ---------------------------------------------------------------- FIT

export const FIT_EPOCH = 631065600;
export const toSemi = (deg: number) => Math.round((deg * 2 ** 31) / 180);

/** Tiny FIT writer: definitions, normal and compressed-timestamp data messages. */
export class Fit {
  body: number[] = [];
  constructor(readonly le = true) {}
  private u8(v: number) { this.body.push(v & 0xff); }
  private n(v: number, size: number) {
    const b = Array.from({ length: size }, (_, i) => Number((BigInt.asUintN(size * 8, BigInt(v)) >> BigInt(8 * i)) & 0xffn));
    this.body.push(...(this.le ? b : b.reverse()));
  }
  /** fields: [field number, size] */
  def(local: number, global: number, fields: [number, number][], devSizes: number[] = []) {
    this.u8(0x40 | (devSizes.length ? 0x20 : 0) | local);
    this.u8(0); this.u8(this.le ? 0 : 1); this.n(global, 2); this.u8(fields.length);
    for (const [num, size] of fields) { this.u8(num); this.u8(size); this.u8(size === 4 ? 0x86 : 0x02); }
    if (devSizes.length) {
      this.u8(devSizes.length);
      devSizes.forEach((s, i) => { this.u8(i); this.u8(s); this.u8(0); });
    }
    return this;
  }
  /** values: [value, size]; dev bytes are appended as zeros */
  data(local: number, values: [number, number][], devBytes = 0) {
    this.u8(local);
    for (const [v, size] of values) this.n(v, size);
    for (let i = 0; i < devBytes; i++) this.u8(0);
    return this;
  }
  compressed(local: number, offset: number, values: [number, number][]) {
    this.u8(0x80 | (local << 5) | (offset & 0x1f));
    for (const [v, size] of values) this.n(v, size);
    return this;
  }
  bytes(): Uint8Array {
    const size = this.body.length;
    const header = [14, 0x20, 0x08, 0x08, size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >>> 24) & 0xff,
      0x2e, 0x46, 0x49, 0x54, 0, 0];
    return new Uint8Array([...header, ...this.body, 0, 0]);
  }
}

