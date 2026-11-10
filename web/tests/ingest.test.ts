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
  w('d.gpx', gpx(line(600, T2024 + 3 * 86400, 3, offset(5000, 0))));    // starts 5 km away
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
    '6,"May 5, 2024",Manual,Run,600,5.0,,600,5000.0',
    '7,"May 1, 2019",Old,Run,600,1.8,activities/e.gpx,600,1797.0',
    '8,"May 5, 2024",Tunnel,Run,320,0.9,activities/g.gpx,320,900.0',
    '9,"May 6, 2024",Treadmill,Run,600,2.0,activities/h.gpx,600,2000.0',
    '10,"May 7, 2024",Lost file,Run,600,2.0,activities/missing.gpx,600,2000.0',
  ];
  writeFileSync(join(dir, 'activities.csv'), [header, ...rows].join('\n') + '\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const opts = (extra: string[] = []) => parseArgs([dir, '--out', join(dir, 'out', 'runs.json'), ...extra]);

describe('ingest', () => {
  test('keeps runs from home and reports every skip', () => {
    const { file, summary } = runIngest(opts(['--since', '2020-01-01']));
    expect(summary.activities).toBe(12);
    expect(summary.kept).toBe(4);
    expect(file.runs.map((r) => r.id)).toEqual(['1', '2', '8', '12']);
    expect(summary.truncated).toBe(1);
    expect(distTo(summary.home[0], summary.home[1], HOME)).toBeLessThan(60);
    expect(summary.cutAtSignalLoss).toBe(1);
    expect(Object.fromEntries(summary.skipped)).toEqual({
      'duplicate track (same GPS data as an earlier activity)': 2,
      'not a run (activity type)': 1,
      'starts more than 200 m from home': 1,
      'no GPS file in export (manual or indoor activity)': 1,
      'outside --since/--until': 1,
      'no GPS track (fewer than 10 timed points)': 1,
      'file listed in activities.csv is missing': 1,
    });
    const [a, , g, k] = file.runs;
    expect(a.csvDist).toBe(2500);                  // Strava's number is kept separately...
    expect(Math.abs(a.dist - 1797)).toBeLessThan(5); // ...dist is what is animated (600 points, 3 m apart)
    expect(k.dur).toBeLessThan(299);               // only the part before the cut
    expect(g.dist).toBeLessThan(950);              // cut before the jump: only ~900 m are animated
    expect(a.sd).toBeLessThan(60);
    expect(file.meta.privacyTrimmed).toBe(false);
    // decoded paths start at the first point and run at real pace
    const [ra] = decodeRuns(file);
    expect(ra.dur).toBe(599);
    expect(distTo(ra.lonlat[1], ra.lonlat[0], HOME)).toBeLessThan(2);
  });

  test('date range and --home', () => {
    expect(runIngest(opts()).summary.kept).toBe(5); // the 2019 run counts without --since
    expect(runIngest(opts(['--until', '2024-05-01'])).file.runs.map((r) => r.id)).toEqual(['7', '1']);
    // both ends are inclusive (the run on 2024-05-01 starts at 07:00 UTC)
    expect(runIngest(opts(['--since', '2024-05-01', '--until', '2024-05-01'])).file.runs.map((r) => r.id)).toEqual(['1']);
    expect(runIngest(opts(['--since', '2024-05-02', '--until', '2024-05-02'])).file.runs.map((r) => r.id)).toEqual(['2']);
    const far = runIngest(opts(['--home', `${offset(5000)[0]},${offset(5000)[1]}`]));
    expect(far.file.runs.map((r) => r.id)).toEqual(['5']);
    expect(far.summary.homeFromOption).toBe(true);
  });

  test('privacy trimming leaves out start distances and the radius', () => {
    const { file } = runIngest(opts(['--privacy-radius', '300']));
    expect(file.meta.privacyTrimmed).toBe(true);
    expect(JSON.stringify(file.meta)).not.toContain('300');
    for (const r of file.runs) expect(r.sd).toBeUndefined();
    for (const r of decodeRuns(file)) expect(distTo(r.lonlat[1], r.lonlat[0], HOME)).toBeGreaterThan(290);
  });

  test('main(): writes the file, prints the summary, exits 0', () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const out = join(dir, 'ok', 'runs.json');
      expect(main([dir, '--out', out])).toBe(0);
      expect(JSON.parse(readFileSync(out, 'utf8')).runs.length).toBe(5);
      const text = String(log.mock.calls[0][0]);
      expect(text).toContain('runs kept:     5');
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
      expect(main([dir, '--out', out, '--sport', 'swim'])).toBe(2);
      expect(main([dir, '--out', out, '--since', '2030-01-01'])).toBe(2);
      expect(readFileSync(out, 'utf8')).toBe('previous');
      expect(String(err.mock.calls[0][0])).toContain('no runs start within');
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
      expect(main([dir, '--out', join(outDir, 'runs.json')])).toBe(1);
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
      ['--max-speed', '0'], ['--privacy-radius', '-1'], ['--bogus'], ['--out'],
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
    const { summary, file } = runIngest(parseArgs([join(dir, 'activities')]));
    expect(summary.fromCsv).toBe(false);
    // a-copy.gpx.gz and a.gpx hold the same track: only the first in sorted order is kept
    expect(file.runs.map((r) => r.id).sort()).toEqual(['a-copy', 'b', 'e', 'g', 'k']);
  });
});
