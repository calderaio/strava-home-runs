import { describe, expect, test } from 'bun:test';
import { clean, distTo, downsample, findHome, findHomes, hideEnds, metresPerDegree, type Track } from '../ingest/track.ts';
import { HOME, offset } from './fixtures.ts';

const [, KX] = metresPerDegree(HOME[0]);

/** Track along a line east of home; `east` offsets in metres, one point per second unless `t` is given. */
function track(east: number[], t?: number[]): Track {
  return {
    start: 0,
    sport: 'running',
    lat: Float64Array.from(east, () => HOME[0]),
    lon: Float64Array.from(east, (e) => HOME[1] + e / KX),
    t: Float64Array.from(t ?? east.map((_, i) => i)),
  };
}
const line = (n: number, speed = 3) => Array.from({ length: n }, (_, i) => i * speed);
const eastOf = (c: Track, i: number) => (c.lon[i] - HOME[1]) * KX;

describe('home detection', () => {
  test('densest start cluster wins over a single far start and a smaller cluster', () => {
    const jitter = (k: number, m: number) => offset(((k % 3) - 1) * m, ((k % 5) - 2) * m);
    const starts: [number, number][] = [
      ...Array.from({ length: 20 }, (_, k) => jitter(k, 15)),
      ...Array.from({ length: 8 }, (_, k) => offset(3000 + k, 2000)),
      offset(-90000, 40000),
    ];
    const h = findHome(starts, 200);
    expect(distTo(h[0], h[1], HOME)).toBeLessThan(10);
  });

  test('a tie goes to the cluster of the first start', () => {
    const a = [offset(0), offset(10), offset(20)];
    const b = [offset(5000), offset(5010), offset(5020)];
    expect(distTo(...findHome([...a, ...b], 100), HOME)).toBeLessThan(30);
    expect(distTo(...findHome([...b, ...a], 100), offset(5000))).toBeLessThan(30);
  });

  test('home is the mean of the cluster around the winning start', () => {
    const h = findHome([offset(0), offset(30), offset(60), offset(900)], 100);
    // start 30 m sees all three (0, 30, 60); the mean is at 30 m
    expect((h[1] - HOME[1]) * KX).toBeCloseTo(30, 6);
  });
});

describe('home candidates', () => {
  const cluster = (east: number, north: number, n: number) => Array.from({ length: n }, (_, k) => offset(east + (k % 4) * 10, north + (k % 3) * 10));

  test('finds every place with enough starts, densest first, each start counted once', () => {
    const starts = [...cluster(50000, 0, 12), ...cluster(0, 0, 30), ...cluster(0, 800, 15), ...cluster(-90000, 0, 9), offset(7000, 7000)];
    const homes = findHomes(starts, 200, 10);
    expect(homes.map((h) => h.members.length)).toEqual([30, 15, 12]); // the 9-run place is below the minimum
    expect(distTo(homes[0].lat, homes[0].lon, offset(15, 10))).toBeLessThan(10);
    expect(distTo(homes[1].lat, homes[1].lon, offset(15, 810))).toBeLessThan(10);
    expect(distTo(homes[2].lat, homes[2].lon, offset(50015, 10))).toBeLessThan(10);
    const all = homes.flatMap((h) => h.members);
    expect(new Set(all).size).toBe(all.length);
    expect(homes[0].members.every((i) => i >= 12 && i < 42)).toBe(true);
  });

  test('the minimum is inclusive, and a high minimum finds nothing', () => {
    const starts = [...cluster(0, 0, 10), ...cluster(5000, 0, 9)];
    expect(findHomes(starts, 200, 10).map((h) => h.members.length)).toEqual([10]);
    expect(findHomes(starts, 200, 9).map((h) => h.members.length)).toEqual([10, 9]);
    expect(findHomes(starts, 200, 11)).toEqual([]);
    expect(findHomes([], 200, 1)).toEqual([]);
  });

  test('privacy trimming around several homes', () => {
    const e = [...line(201), ...line(200).reverse()]; // 600 m out and back from HOME
    const other = offset(600); // a second home at the turning point
    const h = hideEnds(track(e), [HOME, other], 150)!;
    for (let i = 0; i < h.t.length; i++) {
      expect(distTo(h.lat[i], h.lon[i], HOME)).toBeGreaterThan(150);
    }
    expect(Math.max(...Array.from(h.lon, (x) => (x - HOME[1]) * KX))).toBeGreaterThan(450); // the middle stays
  });
});

describe('GPS cleaning', () => {
  test('drops a single spike faster than max speed', () => {
    const e = line(30);
    e[10] = 2000; // 2 km jump in a second
    const c = clean(track(e), 7);
    expect(c.t.length).toBe(29);
    expect(c.cut).toBe(false);
    for (let i = 0; i < c.lon.length; i++) expect(eastOf(c, i)).toBeLessThan(100);
  });

  test('jumps up to 50 m are kept even if fast; beyond 50 m they are spikes', () => {
    const keep = line(20);
    keep[5] += 45;
    expect(clean(track(keep), 7).t.length).toBe(20);
    const drop = line(20);
    drop[5] += 55;
    expect(clean(track(drop), 7).t.length).toBe(19);
  });

  test('a fast jump is fine if enough time passed', () => {
    const e = line(20);
    const t = e.map((_, i) => (i < 10 ? i : i + 100)); // 100 s gap, then 3 m on: slow
    expect(clean(track(e, t), 7).t.length).toBe(20);
  });

  test('9 spikes in a row are skipped; the 10th cuts the track (signal lost for good)', () => {
    const nine = [...line(30), ...Array.from({ length: 9 }, () => 5000), ...line(10).map((x) => 90 + x)];
    const c9 = clean(track(nine), 7);
    expect(c9.cut).toBe(false);
    expect(c9.t.length).toBe(40);
    const ten = [...line(30), ...Array.from({ length: 10 }, () => 5000), ...line(10).map((x) => 90 + x)];
    const c10 = clean(track(ten), 7);
    expect(c10.cut).toBe(true);
    expect(c10.t.length).toBe(30);
    expect(c10.t[c10.t.length - 1]).toBe(29);
  });

  test('shortens pauses to 3x the median interval and drops non-increasing times', () => {
    const e = line(20);
    const t = e.map((_, i) => (i < 10 ? i : i + 300)); // a 5-minute stop
    t[15] = t[14]; // duplicate timestamp
    const c = clean(track(e, t), 7);
    expect(c.t.length).toBe(19);
    expect(c.t[10] - c.t[9]).toBe(3);
    expect(c.t[c.t.length - 1]).toBe(9 + 3 + 4 + 2 + 3); // 9 steps, capped pause, 4 steps, gap over the duplicate, 3 steps
  });
});

describe('privacy trimming', () => {
  test('removes start and end inside the radius and restarts the clock', () => {
    const out = line(201);
    const e = [...out, ...out.slice(0, -1).reverse()]; // 600 m out and back
    const tr = track(e);
    const h = hideEnds(tr, HOME, 300)!;
    for (let i = 0; i < h.lon.length; i++) expect(distTo(h.lat[i], h.lon[i], HOME)).toBeGreaterThan(300);
    expect(h.t[0]).toBe(0);
    expect(distTo(h.lat[0], h.lon[0], HOME)).toBeLessThan(305);
    expect(distTo(h.lat[h.lat.length - 1], h.lon[h.lon.length - 1], HOME)).toBeLessThan(305);
    expect(h.t.length).toBeLessThan(tr.t.length);
  });

  test('keeps a track with exactly 10 points outside, drops one with 9', () => {
    const inside = Array.from({ length: 20 }, (_, i) => i * 10); // 0..190 m
    const ten = [...inside, ...Array.from({ length: 10 }, (_, i) => 400 + i * 3), ...inside.slice().reverse()];
    expect(hideEnds(track(ten), HOME, 300)?.t.length).toBe(10);
    const nine = [...inside, ...Array.from({ length: 9 }, (_, i) => 400 + i * 3), ...inside.slice().reverse()];
    expect(hideEnds(track(nine), HOME, 300)).toBeNull();
  });
});

describe('downsampling', () => {
  test('keeps points at least 5 s and 10 m apart, plus the last', () => {
    const d = downsample(track(line(61, 3)), 5, 10);
    expect(Array.from(d.t)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60]);
    const still = downsample(track(Array.from({ length: 60 }, () => 0)), 5, 10);
    expect(Array.from(still.t)).toEqual([0, 59]);
  });
});
