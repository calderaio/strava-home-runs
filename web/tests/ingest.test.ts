import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { IoError, main, parseArgs, runIngest, UsageError, writeRuns } from '../ingest/ingest.ts';
import { distTo } from '../ingest/track.ts';
import { decodeRuns } from '../src/lib/runs.ts';
import { Fit, FIT_EPOCH, gpx, HOME, line, offset, toSemi } from './fixtures.ts';

// A synthetic Strava archive (open ocean coordinates) in a temp folder.
let dir = '';
const T2024 = Date.UTC(2024, 4, 1, 7) / 1000;
const T2019 = Date.UTC(2019, 4, 1, 7) / 1000;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'homeruns-test-'));
  mkdirSync(join(dir, 'activities'));
  const w = (name: string, text: string, gz = false) =>
    writeFileSync(join(dir, 'activities', name), gz ? gzipSync(text) : text);
  w('a.gpx', gpx(line(600, T2024)));                                   // 1.8 km run from home
  w('a-copy.gpx.gz', gpx(line(600, T2024)), true);                      // same track, other name, gzipped
  w('b.gpx.gz', gpx(line(400, T2024 + 86400, 2.5, offset(0, 50))), true); // starts 50 m away
  w('c.gpx', gpx(line(600, T2024 + 2 * 86400, 6), 'cycling'));          // a ride
  w('d.gpx', gpx(line(600, T2024 + 3 * 86400, 3, offset(5000, 0))));    // starts 5 km away...
  w('d2.gpx', gpx(line(500, T2024 + 8 * 86400, 3, offset(5000, 30))));  // ...twice: a second home
  // starts 250 m west of the second home and runs east right past it
  w('d3.gpx', gpx(line(750, T2024 + 9 * 86400, 2, offset(4750, 0))));
  w('e.gpx', gpx(line(600, T2019)));                                    // too early for --since
  // runs 300 points, then the signal is lost for good: 20 points 3 km away
  w('g.gpx', gpx([...line(300, T2024 + 4 * 86400), ...line(20, T2024 + 4 * 86400 + 300, 3, offset(3000, 3000))]));
  w('h.gpx', '<gpx><trk><trkseg></trkseg></trk></gpx>');               // empty (indoor)
  // a FIT run that is cut off in the middle of a record: the first points are still usable
  const fit = new Fit();
  fit.def(0, 20, [[253, 4], [0, 4], [1, 4]]);
  line(300, T2024 + 5 * 86400).forEach((p) => fit.data(0, [[p.t - FIT_EPOCH, 4], [toSemi(p.lat), 4], [toSemi(p.lon), 4]]));
  const bytes = fit.bytes();
  writeFileSync(join(dir, 'activities', 'k.fit.gz'), gzipSync(bytes.subarray(0, bytes.length - 1000)));
  const header = 'Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Elapsed Time,Distance';
  const rows = [
    '1,"May 1, 2024",Morning Run,Run,600,1.8,activities/a.gpx,600,2500.0',
    '2,"May 2, 2024",Second,Run,400,1.0,activities/b.gpx.gz,400,998.0',
    '3,"May 1, 2024",Same file twice,Run,600,1.8,activities/a.gpx,600,1797.0',
    '11,"May 1, 2024",Same track other file,Run,600,1.8,activities/a-copy.gpx.gz,600,1797.0',
    '12,"May 6, 2024",Cut off,Run,300,0.9,activities/k.fit.gz,300,900.0',
    '4,"May 3, 2024",Ride,Ride,600,3.6,activities/c.gpx,600,3594.0',
    '5,"May 4, 2024",Far,Run,600,1.8,activities/d.gpx,600,1797.0',
    '13,"May 9, 2024",Far again,Run,500,1.5,activities/d2.gpx,500,1497.0',
    '14,"May 10, 2024",Past the far home,Run,750,1.5,activities/d3.gpx,750,1498.0',
    '6,"May 5, 2024",Manual,Run,600,5.0,,600,5000.0',
    '7,"May 1, 2019",Old,Run,600,1.8,activities/e.gpx,600,1797.0',
    '8,"May 5, 2024",Tunnel,Run,320,0.9,activities/g.gpx,320,900.0',
    '9,"May 6, 2024",Treadmill,Run,600,2.0,activities/h.gpx,600,2000.0',
    '10,"May 7, 2024",Lost file,Run,600,2.0,activities/missing.gpx,600,2000.0',
  ];
  writeFileSync(join(dir, 'activities.csv'), [header, ...rows].join('\n') + '\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const opts = (extra: string[] = []) => parseArgs([dir, '--out', join(dir, 'out', 'runs.json'), '--min-home-runs', '2', ...extra]);

describe('ingest', () => {
  test('keeps every run with GPS, finds the home and reports every skip', () => {
    const { file, summary } = runIngest(opts(['--since', '2020-01-01']));
    expect(summary.activities).toBe(14);
    expect(summary.kept).toBe(7);
    expect(file.runs.map((r) => r.id)).toEqual(['1', '2', '5', '8', '12', '13', '14']); // incl. the runs from 5 km away
    expect(summary.truncated).toBe(1);
    expect(file.meta.homes.length).toBe(2);
    const [h, far] = file.meta.homes;
    expect(distTo(h.lat, h.lon, HOME)).toBeLessThan(60);
    expect([h.runs, h.first, h.last]).toEqual([4, 2024, 2024]);
    expect(far.runs).toBe(2);
    expect(h.id).toBe('h:1');   // the earliest run starting there
    expect(far.id).toBe('h:5');
    expect(file.meta.homeSpacing).toBe(1000);
    expect(summary.homes).toEqual(file.meta.homes);
    expect(summary.cutAtSignalLoss).toBe(1);
    expect(Object.fromEntries(summary.skipped)).toEqual({
      'duplicate track (same GPS data as an earlier activity)': 2,
      'not a run (activity type)': 1,
      'no GPS file in export (manual or indoor activity)': 1,
      'outside --since/--until': 1,
      'no GPS track (fewer than 10 timed points)': 1,
      'file listed in activities.csv is missing': 1,
    });
    const byId = (id: string) => file.runs.find((r) => r.id === id)!;
    const [a, g, k] = [byId('1'), byId('8'), byId('12')];
    expect(a.csvDist).toBe(2500);                  // Strava's number is kept separately...
    expect(Math.abs(a.dist - 1797)).toBeLessThan(5); // ...dist is what is animated (600 points, 3 m apart)
    expect(k.dur).toBeLessThan(299);               // only the part before the cut
    expect(g.dist).toBeLessThan(950);              // cut before the jump: only ~900 m are animated
    expect(file.meta.privacyTrimmed).toBe(false);
    // decoded paths start at the first point and run at real pace
    const [ra] = decodeRuns(file);
    expect(ra.dur).toBe(599);
    expect(distTo(ra.lonlat[1], ra.lonlat[0], HOME)).toBeLessThan(2);
  });

  test('date range and --home', () => {
    expect(runIngest(opts()).summary.kept).toBe(8); // the 2019 run counts without --since
    expect(runIngest(opts(['--until', '2024-05-01'])).file.runs.map((r) => r.id)).toEqual(['7', '1']);
    // both ends are inclusive (the run on 2024-05-01 starts at 07:00 UTC)
    expect(runIngest(opts(['--since', '2024-05-01', '--until', '2024-05-01', '--min-home-runs', '1'])).file.runs.map((r) => r.id)).toEqual(['1']);
    expect(runIngest(opts(['--since', '2024-05-02', '--until', '2024-05-02', '--min-home-runs', '1'])).file.runs.map((r) => r.id)).toEqual(['2']);
    // --home adds a home first...
    const far = runIngest(opts(['--home', `${offset(5000)[0]},${offset(5000)[1]}`])).file.meta.homes;
    expect(() => runIngest(opts(['--home', `${offset(9000)[0]},${offset(9000)[1]}`]))).toThrow(/no runs start within 200 m of --home/);
    expect(far.map((h) => [h.runs, !!h.fromOption])).toEqual([[2, true], [5, false]]);
    // ...or replaces the detected home it is close to
    const near = runIngest(opts(['--home', `${offset(50)[0]},${offset(50)[1]}`])).file.meta.homes;
    expect(near.length).toBe(2);
    expect(near[0].fromOption).toBe(true);
    expect(distTo(near[0].lat, near[0].lon, offset(50))).toBeLessThan(1e-6);
    // fewer starts than --min-home-runs anywhere: no home, an error
    expect(() => runIngest(opts(['--min-home-runs', '50']))).toThrow(/no place has 50 or more runs/);
  });

  test('privacy: every run loses its own start and end, ends near every home go too, homes are rounded', () => {
    const plainFile = runIngest(opts()).file;
    const plain = new Map(decodeRuns(plainFile).map((r) => [r.id, r]));
    for (const R of [300, 600]) {
      const { file } = runIngest(opts(['--privacy-radius', String(R)]));
      expect(file.meta.privacyTrimmed).toBe(true);
      expect(file.meta.radius).toBe(2000); // fixed: says nothing about R
      expect(JSON.stringify(file.meta)).not.toContain(String(R));
      file.meta.homes.forEach((h, i) => {
        expect(h.lat).toBe(Math.round(plainFile.meta.homes[i].lat * 100) / 100);
        expect(h.lon).toBe(Math.round(plainFile.meta.homes[i].lon * 100) / 100);
      });
      const runs = decodeRuns(file);
      expect(runs.length).toBeGreaterThan(0);
      for (const r of runs) {
        const o = plain.get(r.id)!;
        const n = r.t.length, m = o.t.length;
        // no run begins or ends within R of where it originally began or ended
        expect(distTo(r.lonlat[1], r.lonlat[0], [o.lonlat[1], o.lonlat[0]])).toBeGreaterThan(R - 2);
        expect(distTo(r.lonlat[2 * n - 1], r.lonlat[2 * n - 2], [o.lonlat[2 * m - 1], o.lonlat[2 * m - 2]])).toBeGreaterThan(R - 2);
        // nor within R of any home, including the second one
        for (const h of plainFile.meta.homes) expect(distTo(r.lonlat[1], r.lonlat[0], [h.lat, h.lon])).toBeGreaterThan(R - 2);
      }
      // the far runs (second home) are kept, trimmed; run 14 passes the second home right after its
      // start, so only the trim around that home (not its own start) removes those points
      expect(runs.some((r) => r.id === '13')).toBe(true);
      const r14 = runs.find((r) => r.id === '14')!;
      expect(distTo(r14.lonlat[1], r14.lonlat[0], [plainFile.meta.homes[1].lat, plainFile.meta.homes[1].lon])).toBeGreaterThan(R - 2);
    }
  });

  test('main(): writes the file, prints the summary, exits 0', () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const out = join(dir, 'ok', 'runs.json');
      expect(main([dir, '--out', out, '--min-home-runs', '2'])).toBe(0);
      expect(JSON.parse(readFileSync(out, 'utf8')).runs.length).toBe(8);
      const text = String(log.mock.calls[0][0]);
      expect(text).toContain('runs kept:     8 with GPS');
      expect(text).toContain('homes:         2');
      expect(text).toMatch(/ 1\. -\d+\.\d{4}, -\d+\.\d{4} · 5 runs · 2019-2024/);
      expect(text).toContain('cut at signal loss: 1');
      expect(text).toContain('truncated:     1 files (partial data kept)');
      expect(text).toContain('2  duplicate track (same GPS data as an earlier activity)');
    } finally {
      log.mockRestore();
    }
  });

  test('main(): an empty result fails and keeps the existing output', () => {
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const out = join(dir, 'keep', 'runs.json');
      mkdirSync(join(dir, 'keep'));
      writeFileSync(out, 'previous');
      expect(main([dir, '--out', out, '--home', '0,0'])).toBe(2);
      expect(main([dir, '--out', out])).toBe(2); // 6 runs: no place has the default 10
      expect(main([dir, '--out', out, '--sport', 'swim'])).toBe(2);
      expect(main([dir, '--out', out, '--since', '2030-01-01'])).toBe(2);
      expect(readFileSync(out, 'utf8')).toBe('previous');
      expect(String(err.mock.calls[0][0])).toContain('no runs start within 200 m of --home');
    } finally {
      err.mockRestore();
    }
  });

  test('a failed write leaves no temp file, keeps the old output and exits 1', () => {
    const { file } = runIngest(opts());
    const outDir = join(dir, 'blocked');
    mkdirSync(join(outDir, 'runs.json'), { recursive: true }); // the output path is a folder: rename fails
    expect(() => writeRuns(join(outDir, 'runs.json'), file)).toThrow(IoError);
    expect(readdirSync(outDir)).toEqual(['runs.json']);
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(main([dir, '--out', join(outDir, 'runs.json'), '--min-home-runs', '2'])).toBe(1);
      expect(String(err.mock.calls[0][0])).toMatch(/^error: could not write/);
      expect(readdirSync(outDir)).toEqual(['runs.json']);
    } finally {
      err.mockRestore();
    }
  });

  test('argument validation', () => {
    const bad = [
      ['--radius', '-5'], ['--radius', '0'], ['--radius', 'abc'], ['--home', '0'], ['--home', '91,0'], ['--home', ',5'],
      ['--since', '2024-13-45'], ['--until', '2023-02-30'], ['--since', '2024-05-02', '--until', '2024-05-01'],
      ['--max-speed', '0'], ['--privacy-radius', '-1'], ['--min-home-runs', '0'], ['--bogus'], ['--out'],
    ];
    for (const b of bad) expect(() => parseArgs([dir, ...b]), b.join(' ')).toThrow(UsageError);
    expect(parseArgs([dir, '--since', '2024-02-29']).since).toBe('2024-02-29');
  });

  test('clear errors for a missing folder and a non-English activities.csv', () => {
    expect(() => runIngest(parseArgs([join(dir, 'nope')]))).toThrow(/input folder not found/);
    const de = mkdtempSync(join(tmpdir(), 'homeruns-de-'));
    try {
      writeFileSync(join(de, 'activities.csv'), 'Aktivitäts-ID,Aktivitätsdatum,Name,Aktivitätsart,Dateiname\n1,x,y,Lauf,a.gpx\n');
      expect(() => runIngest(parseArgs([de]))).toThrow(/another language/);
    } finally {
      rmSync(de, { recursive: true, force: true });
    }
  });

  test('without activities.csv it scans the files and uses their sport', () => {
    const { summary, file } = runIngest(parseArgs([join(dir, 'activities'), '--min-home-runs', '2']));
    expect(summary.fromCsv).toBe(false);
    // a-copy.gpx.gz and a.gpx hold the same track: only the first in sorted order is kept
    expect(file.runs.map((r) => r.id).sort()).toEqual(['a-copy', 'b', 'd', 'd2', 'd3', 'e', 'g', 'k']);
  });
});
