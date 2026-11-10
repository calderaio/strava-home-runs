import { describe, expect, test } from 'bun:test';
import { decodeRuns, filterRuns, headAt } from '../src/lib/runs.ts';
import { encodePath, type RunsFile } from '../src/lib/format.ts';
import { HOME, REF, run } from './fixtures.ts';

describe('filterRuns', () => {
  const runs = [
    run([0, 0, 1, 1], [0, 10], { id: 'a', day: '2024-01-01', sd: 0 }),
    run([0, 0, 1, 1], [0, 10], { id: 'b', day: '2024-06-30', sd: 150 }),
    run([0, 0, 1, 1], [0, 10], { id: 'c', day: '2024-12-31', sd: 151 }),
    run([0, 0, 1, 1], [0, 10], { id: 'd', day: '2025-01-01', sd: null }),
    run([0, 0], [0], { id: 'e', day: '2024-06-30', sd: 0 }), // a single point can't be drawn
  ];
  const ids = (from: string, to: string, maxStart: number) => filterRuns(runs, { from, to, maxStart }).map((r) => r.id);

  test('date range is inclusive at both ends', () => {
    expect(ids('2024-01-01', '2024-12-31', 1000)).toEqual(['a', 'b', 'c']);
    expect(ids('2024-01-02', '2024-12-30', 1000)).toEqual(['b']);
    expect(ids('2024-06-30', '2024-06-30', 1000)).toEqual(['b']);
  });

  test('start radius is inclusive; runs without a start distance (privacy-trimmed) always pass', () => {
    expect(ids('0000', '9999', 150)).toEqual(['a', 'b', 'd']);
    expect(ids('0000', '9999', 149)).toEqual(['a', 'd']);
    expect(ids('0000', '9999', 151)).toEqual(['a', 'b', 'c', 'd']);
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
  test('decodes paths, dates and the optional start distance', () => {
    const file: RunsFile = {
      version: 1, generatedAt: '', scale: 1e5, ref: REF,
      meta: { radius: 200, privacyTrimmed: false, maxSpeed: 7, sport: 'run', since: null, until: null },
      runs: [
        { id: '1', name: 'a', date: '2024-05-01T07:00:00Z', dist: 100, dur: 60, sd: 12, p: encodePath([HOME[1], HOME[1] + 1e-3], [HOME[0], HOME[0]], [0, 60], REF, 1e5) },
        { id: '2', name: 'b', date: '2023-12-31T23:30:00Z', dist: 100, dur: 60, p: encodePath([HOME[1], HOME[1]], [HOME[0], HOME[0] + 1e-3], [0, 60], REF, 1e5) },
      ],
    };
    const [a, b] = decodeRuns(file);
    expect(a.day).toBe('2024-05-01');
    expect(a.year).toBe(2024);
    expect(a.sd).toBe(12);
    expect(a.dur).toBe(60);
    expect(a.lonlat[2]).toBeCloseTo(HOME[1] + 1e-3, 9);
    expect(b.sd).toBeNull();
    expect(b.year).toBe(2023);
    expect(() => decodeRuns({ ...file, version: 2 } as unknown as RunsFile)).toThrow();
  });
});
