import { describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { parseFit } from '../ingest/fit.ts';
import { parseTrackBytes } from '../ingest/track.ts';
import { HOME } from './fixtures.ts';

const FIT_EPOCH = 631065600;
const toSemi = (deg: number) => Math.round((deg * 2 ** 31) / 180);

/** Tiny FIT writer: definitions, normal and compressed-timestamp data messages. */
class Fit {
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

const T0 = 1700000000;
const PTS: [number, number, number][] = Array.from({ length: 12 }, (_, i) => [HOME[0] + i * 1e-4, HOME[1] + i * 1e-4, T0 + i]);
const REC: [number, number][] = [[253, 4], [0, 4], [1, 4], [3, 1]]; // timestamp, lat, lon, heart rate
const rec = (lat: number, lon: number, ts: number): [number, number][] =>
  [[ts - FIT_EPOCH, 4], [toSemi(lat), 4], [toSemi(lon), 4], [140, 1]];

/** session (sport) + records; the last record uses a compressed timestamp header */
function buildFit(points: [number, number, number][], opts: { bigEndian?: boolean; devField?: boolean } = {}): Uint8Array {
  const w = new Fit(!opts.bigEndian);
  w.def(1, 18, [[5, 1]]).data(1, [[1, 1]]); // session: sport = running
  w.def(0, 20, REC, opts.devField ? [2] : []);
  points.slice(0, -1).forEach(([la, lo, ts]) => w.data(0, rec(la, lo, ts), opts.devField ? 2 : 0));
  const [la, lo, ts] = points[points.length - 1];
  w.def(2, 20, [[0, 4], [1, 4]]).compressed(2, ts - FIT_EPOCH, [[toSemi(la), 4], [toSemi(lo), 4]]);
  // an indoor sample without position is ignored
  w.data(0, [[points[0][2] - FIT_EPOCH + 1, 4], [0x7fffffff, 4], [0x7fffffff, 4], [141, 1]], opts.devField ? 2 : 0);
  return w.bytes();
}

describe('FIT', () => {
  test('reads records, sport and a compressed timestamp', () => {
    const r = parseFit(buildFit(PTS));
    expect(r.sport).toBe('running');
    expect(r.lat.length).toBe(12);
    expect(r.time).toEqual(PTS.map((p) => p[2]));
    for (let i = 0; i < 12; i++) {
      expect(r.lat[i]).toBeCloseTo(PTS[i][0], 6);
      expect(r.lon[i]).toBeCloseTo(PTS[i][1], 6);
    }
  });

  test('big-endian definitions and developer fields', () => {
    const r = parseFit(buildFit(PTS, { bigEndian: true, devField: true }));
    expect(r.lat.length).toBe(12);
    expect(r.time[11]).toBe(T0 + 11);
    expect(r.lon[5]).toBeCloseTo(HOME[1] + 5e-4, 6);
  });

  test('compressed timestamps roll over the 5-bit offset', () => {
    const base = T0 - ((T0 - FIT_EPOCH) & 0x1f) + 30; // low 5 bits of the FIT time = 30
    const w = new Fit();
    w.def(0, 20, REC).data(0, rec(HOME[0], HOME[1], base));
    w.def(2, 20, [[0, 4], [1, 4]]);
    // offset 2 < 30: the clock wrapped, so this is base + 4; offset 31 is base + 1 (no wrap)
    w.compressed(2, 31, [[toSemi(HOME[0]), 4], [toSemi(HOME[1]), 4]]);
    w.compressed(2, 2, [[toSemi(HOME[0]), 4], [toSemi(HOME[1]), 4]]);
    const r = parseFit(w.bytes());
    expect(r.time.map((t) => t - base)).toEqual([0, 1, 4]);
  });

  test('(0, 0) positions and the invalid-timestamp sentinel are dropped', () => {
    const w = new Fit();
    w.def(0, 20, REC);
    w.data(0, rec(HOME[0], HOME[1], T0));
    w.data(0, [[T0 - FIT_EPOCH + 1, 4], [0, 4], [0, 4], [140, 1]]);          // null island
    w.data(0, [[0xffffffff, 4], [toSemi(HOME[0]), 4], [toSemi(HOME[1]), 4], [140, 1]]); // no timestamp
    w.data(0, rec(HOME[0] + 1e-4, HOME[1], T0 + 3));
    const r = parseFit(w.bytes());
    expect(r.time).toEqual([T0, T0 + 3]);
    expect(r.lat[0]).not.toBe(0);
  });

  test('sport comes from session field 5 (not other fields)', () => {
    const w = new Fit();
    w.def(1, 18, [[4, 1], [5, 1], [6, 1]]).data(1, [[1, 1], [2, 1], [1, 1]]); // field 4/6 = 1, sport (5) = cycling
    w.def(0, 20, REC);
    PTS.forEach(([la, lo, ts]) => w.data(0, rec(la, lo, ts)));
    expect(parseFit(w.bytes()).sport).toBe('cycling');
  });

  test('gzipped FIT via parseTrackBytes', () => {
    const r = parseTrackBytes(gzipSync(buildFit(PTS)), 'x.fit.gz');
    expect(r.lat.length).toBe(12);
    expect(r.sport).toBe('running');
  });

  test('chained FIT files are concatenated', () => {
    const r = parseFit(new Uint8Array([...buildFit(PTS.slice(0, 6)), ...buildFit(PTS.slice(6))]));
    expect(r.lat.length).toBe(12);
  });

  test('a truncated file keeps the records read so far', () => {
    const full = buildFit(PTS);
    const r = parseFit(full.subarray(0, full.length - 40)); // cut inside the last records
    expect(r.lat.length).toBeGreaterThan(5);
    expect(r.lat.length).toBeLessThan(12);
    expect(r.time[0]).toBe(T0);
  });

  test('rejects non-FIT data and files that fail before any record', () => {
    expect(() => parseFit(new Uint8Array(20))).toThrow();
    const w = new Fit();
    w.data(5, [[1, 1]]); // data message for an undefined local type, nothing read yet
    expect(() => parseFit(w.bytes())).toThrow(/undefined local type/);
  });
});
