import { describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { parseFit } from '../ingest/fit.ts';
import { parseTrackBytes } from '../ingest/track.ts';
import { Fit, FIT_EPOCH, HOME, toSemi } from './fixtures.ts';


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
    expect(r.truncated).toBeUndefined();
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

  test('sport also comes from the sport message, field 0 (not other fields)', () => {
    const w = new Fit();
    w.def(3, 12, [[1, 1], [0, 1], [2, 1]]).data(3, [[2, 1], [11, 1], [2, 1]]); // field 0 = walking; 1 and 2 = cycling
    w.def(0, 20, REC);
    PTS.forEach(([la, lo, ts]) => w.data(0, rec(la, lo, ts)));
    expect(parseFit(w.bytes()).sport).toBe('walking');
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
    expect(r.truncated).toBe(true);
    expect(r.lat.length).toBeGreaterThan(5);
    expect(r.lat.length).toBeLessThan(12);
    expect(r.time[0]).toBe(T0);
  });

  test('each truncation is flagged on its own: header promises more data, or a corrupt message', () => {
    // 1) cut exactly after a whole record: decoding ends cleanly, but the header says there is more
    const w = new Fit();
    w.def(0, 20, REC);
    PTS.forEach(([la, lo, ts]) => w.data(0, rec(la, lo, ts)));
    const full = w.bytes();
    const recordSize = 1 + 4 + 4 + 4 + 1;
    const cut = parseFit(full.subarray(0, full.length - 2 - 3 * recordSize));
    expect(cut.lat.length).toBe(9);
    expect(cut.truncated).toBe(true);
    // 2) complete length, but a message for an undefined local type halfway
    const c = new Fit();
    c.def(0, 20, REC);
    PTS.slice(0, 5).forEach(([la, lo, ts]) => c.data(0, rec(la, lo, ts)));
    c.data(7, [[1, 1]]);
    PTS.slice(5).forEach(([la, lo, ts]) => c.data(0, rec(la, lo, ts)));
    const corrupt = parseFit(c.bytes());
    expect(corrupt.lat.length).toBe(5);
    expect(corrupt.truncated).toBe(true);
    // 3) an intact file is not flagged
    expect(parseFit(full).truncated).toBeUndefined();
  });

  test('rejects non-FIT data and files that fail before any record', () => {
    expect(() => parseFit(new Uint8Array(20))).toThrow();
    const w = new Fit();
    w.data(5, [[1, 1]]); // data message for an undefined local type, nothing read yet
    expect(() => parseFit(w.bytes())).toThrow(/undefined local type/);
  });
});
