import { describe, expect, test } from 'bun:test';
import { decodeRuns, distToHome, filterRuns, headAt, homeRange, trimAround, type Run } from '../src/lib/runs.ts';
import { encodePath, type RunsFile } from '../src/lib/format.ts';
import { HOME, offset, REF, run } from './fixtures.ts';

describe('filterRuns by an arbitrary home', () => {
  const at = (east: number, north: number, extra: Partial<Run>) => {
    const [lat, lon] = offset(east, north);
    return run([lon, lat, lon + 1e-3, lat], [0, 10], extra);
  };
  const home = { lat: HOME[0], lon: HOME[1] };
  const elsewhere = (() => { const [lat, lon] = offset(30000, 0); return { lat, lon }; })();
  const runs = [
    at(0, 0, { id: 'a', day: '2024-01-01' }),
    at(150, 0, { id: 'b', day: '2024-06-30' }),
    at(0, 151, { id: 'c', day: '2024-12-31' }),
    at(30000, 100, { id: 'far', day: '2025-01-01' }),
    run([HOME[1], HOME[0]], [0], { id: 'single', day: '2024-06-30' }), // a single point can't be drawn
  ];
  const ids = (from: string, to: string, maxStart: number, h = home) => filterRuns(runs, { from, to, maxStart, home: h }).map((r) => r.id);

  test('date range is inclusive at both ends', () => {
    expect(ids('2024-01-01', '2024-12-31', 1000)).toEqual(['a', 'b', 'c']);
    expect(ids('2024-01-02', '2024-12-30', 1000)).toEqual(['b']);
    expect(ids('2024-06-30', '2024-06-30', 1000)).toEqual(['b']);
  });

  test('start distance is measured from the chosen home, inclusive', () => {
    expect(ids('0000', '9999', 150.5)).toEqual(['a', 'b']);
    expect(ids('0000', '9999', 149)).toEqual(['a']);
    expect(ids('0000', '9999', 152)).toEqual(['a', 'b', 'c']);
    expect(ids('0000', '9999', 200, elsewhere)).toEqual(['far']);
    expect(ids('0000', '9999', 50, elsewhere)).toEqual([]);
  });

  test('homeRange counts the runs and their dates for any home', () => {
    expect(homeRange(runs, home, 200)).toEqual({ count: 4, first: '2024-01-01', last: '2024-12-31' });
    expect(homeRange(runs, elsewhere, 200)).toEqual({ count: 1, first: '2025-01-01', last: '2025-01-01' });
    expect(homeRange(runs, elsewhere, 10).count).toBe(0);
  });
});

describe('page-side privacy trimming', () => {
  // out 600 m east and back, one point per 30 m / 10 s
  const pts = [...Array.from({ length: 21 }, (_, i) => i * 30), ...Array.from({ length: 20 }, (_, i) => 570 - i * 30)];
  const coords = pts.flatMap((e) => { const [lat, lon] = offset(e); return [lon, lat]; });
  const r = run(coords, pts.map((_, i) => i * 10));
  const home = { lat: HOME[0], lon: HOME[1] };

  test('drops the ends within the radius of the chosen home and restarts the clock', () => {
    const t = trimAround(r, home, 200)!;
    for (let i = 0; i < t.t.length; i++) expect(distToHome(t.lonlat[2 * i], t.lonlat[2 * i + 1], home)).toBeGreaterThan(200);
    expect(t.t[0]).toBe(0);
    expect(t.dur).toBe(t.t[t.t.length - 1]);
    expect(t.start).toEqual([t.lonlat[0], t.lonlat[1]]);
    expect(distToHome(t.start[0], t.start[1], home)).toBeLessThan(231);
    expect(t.t.length).toBe(41 - 7 - 7); // 0..180 m out and 180..0 m back are inside
  });

  test('radius 0 keeps the run; a run that never leaves the radius disappears', () => {
    expect(trimAround(r, home, 0)).toBe(r);
    expect(trimAround(r, home, 1000)).toBeNull();
    // trimming around another home leaves this run alone
    const [lat, lon] = offset(30000);
    expect(trimAround(r, { lat, lon }, 200)!.t.length).toBe(41);
  });
});

describe('headAt', () => {
  test('interpolates and disappears at the finish', () => {
    const r = run([-140, -20, -139.99, -20, -139.99, -19.99], [0, 100, 200]);
    expect(headAt(r, 0)).toEqual([-140, -20]);
    const h = headAt(r, 50)!;
    expect(h[0]).toBeCloseTo(-139.995, 9);
    expect(h[1]).toBeCloseTo(-20, 9);
    expect(headAt(r, 199.9)).not.toBeNull();
    expect(headAt(r, 200)).toBeNull();
  });
});

describe('decodeRuns', () => {
  test('decodes paths, dates and start points; rejects other versions', () => {
    const file: RunsFile = {
      version: 2, generatedAt: '', scale: 1e5, ref: REF,
      meta: { radius: 200, privacyTrimmed: false, homes: [{ lat: HOME[0], lon: HOME[1], runs: 2, first: 2023, last: 2024 }], maxSpeed: 7, sport: 'run', since: null, until: null },
      runs: [
        { id: '1', name: 'a', date: '2024-05-01T07:00:00Z', dist: 100, dur: 60, p: encodePath([HOME[1], HOME[1] + 1e-3], [HOME[0], HOME[0]], [0, 60], REF, 1e5) },
        { id: '2', name: 'b', date: '2023-12-31T23:30:00Z', dist: 100, dur: 60, p: encodePath([HOME[1], HOME[1]], [HOME[0], HOME[0] + 1e-3], [0, 60], REF, 1e5) },
      ],
    };
    const [a, b] = decodeRuns(file);
    expect(a.day).toBe('2024-05-01');
    expect(a.year).toBe(2024);
    expect(a.dur).toBe(60);
    expect(a.lonlat[2]).toBeCloseTo(HOME[1] + 1e-3, 9);
    expect(a.start[0]).toBeCloseTo(HOME[1], 9);
    expect(a.start[1]).toBeCloseTo(HOME[0], 9);
    expect(b.year).toBe(2023);
    expect(() => decodeRuns({ ...file, version: 1 } as unknown as RunsFile)).toThrow(/version 1/);
  });
});
