/**
 * Turn a Strava archive (or a folder of FIT/GPX/TCX files) into a compact runs.json for the web page.
 *
 *   bun ingest/ingest.ts [export folder] [--radius 200] [--home lat,lon] [--since YYYY-MM-DD]
 *        [--until YYYY-MM-DD] [--sport run] [--max-speed 7] [--privacy-radius 0]
 *        [--min-dt 5] [--min-dist 10] [--out data/runs.json]
 *
 * The export folder is only read, never written.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePath, type HomeCandidate, type RunRecord, type RunsFile } from '../src/lib/format.ts';
import { groupHomes } from '../src/lib/homes.ts';
import { parseCsv } from './csv.ts';
import {
  clean, distTo, downsample, findHomes, formatOf, hidePrivateEnds, parseTrackBytes, pathLength, toTrack, type Track,
} from './track.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCALE = 1e5; // ~1 m
const PRIVATE_DEFAULT_RADIUS = 2000;

export interface Options {
  input: string;
  radius: number;
  home: [number, number] | null;
  since: string | null;
  until: string | null;
  sport: string;
  maxSpeed: number;
  privacyRadius: number;
  minDt: number;
  minDist: number;
  minHomeRuns: number;
  homeSpacing: number;
  out: string;
}

export class UsageError extends Error {}
/** Failure that is not about the arguments (e.g. the output can't be written): message only, exit 1. */
export class IoError extends Error {}

const USAGE = `usage: bun ingest/ingest.ts [strava export folder | folder of .fit/.gpx/.tcx] [options]
  (default input: the newest export_* folder in the repo root)
  --radius <m>          a home's runs start within this many metres of it; the page's default (200)
  --home <lat,lon>      add this home first (or replace the detected home it is close to)
  --min-home-runs <n>   a place needs this many run starts to become a home candidate (10)
  --home-spacing <m>    the page lists homes closer than this to a larger one as nearby start spots (1000)
  --since <YYYY-MM-DD>  first date to include (UTC)
  --until <YYYY-MM-DD>  last date to include (UTC)
  --sport <name>        keep activities whose type contains this; "any" keeps all (run)
  --max-speed <m/s>     faster GPS jumps are dropped as spikes (7)
  --privacy-radius <m>  trim each run's start and end within this radius of where it began and ended
                        and of every home; homes are then rounded to ~1 km (0)
  --min-dt <s>          minimum time between kept points (5)
  --min-dist <m>        minimum distance between kept points (10)
  --out <file>          output JSON (web/data/runs.json)`;

const isDay = (v: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; // rejects 2024-13-45, 2023-02-30
};

export function parseArgs(argv: string[]): Options {
  const o: Options = {
    input: '', radius: 200, home: null, since: null, until: null, sport: 'run', maxSpeed: 7,
    privacyRadius: 0, minDt: 5, minDist: 10, minHomeRuns: 10, homeSpacing: 1000, out: join(HERE, '..', 'data', 'runs.json'),
  };
  const num = (k: string, v: string | undefined, min: number, strict = false) => {
    const n = Number(v);
    if (v === undefined || v.trim() === '' || !Number.isFinite(n) || n < min || (strict && n === min)) {
      throw new UsageError(`${k} needs a number ${strict ? '>' : '>='} ${min}, got ${v ?? 'nothing'}`);
    }
    return n;
  };
  const day = (k: string, v: string | undefined) => {
    if (!v || !isDay(v)) throw new UsageError(`${k} needs a valid date YYYY-MM-DD, got ${v ?? 'nothing'}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    switch (a) {
      case '-h': case '--help': throw new UsageError('');
      case '--radius': o.radius = num(a, v, 0, true); i++; break;
      case '--home': {
        const p = (v ?? '').split(',').map((x) => (x.trim() === '' ? NaN : Number(x)));
        if (p.length !== 2 || !p.every(Number.isFinite) || Math.abs(p[0]) > 90 || Math.abs(p[1]) > 180) {
          throw new UsageError(`--home needs lat,lon in degrees, got ${v ?? 'nothing'}`);
        }
        o.home = [p[0], p[1]]; i++; break;
      }
      case '--since': o.since = day(a, v); i++; break;
      case '--until': o.until = day(a, v); i++; break;
      case '--sport':
        if (!v || v.startsWith('--')) throw new UsageError('--sport needs a name');
        o.sport = v.toLowerCase(); i++; break;
      case '--max-speed': o.maxSpeed = num(a, v, 0, true); i++; break;
      case '--privacy-radius': o.privacyRadius = num(a, v, 0); i++; break;
      case '--min-dt': o.minDt = num(a, v, 0); i++; break;
      case '--min-dist': o.minDist = num(a, v, 0); i++; break;
      case '--min-home-runs': o.minHomeRuns = Math.round(num(a, v, 1)); i++; break;
      case '--home-spacing': o.homeSpacing = num(a, v, 0); i++; break;
      case '--out':
        if (!v || v.startsWith('--')) throw new UsageError('--out needs a path');
        o.out = resolve(v); i++; break;
      default:
        if (a.startsWith('-')) throw new UsageError(`unknown option ${a}`);
        if (o.input) throw new UsageError('only one input folder');
        o.input = resolve(a);
    }
  }
  if (o.since && o.until && o.since > o.until) throw new UsageError(`--since ${o.since} is after --until ${o.until}`);
  if (!o.input) {
    o.input = defaultInput() ?? '';
    if (!o.input) throw new UsageError('missing input folder (and no export_* folder with activities.csv in the repo root)');
  }
  return o;
}

// Without an argument, use the newest unzipped Strava archive (export_...) in the repo root; it is gitignored.
function defaultInput(): string | null {
  const root = join(HERE, '..', '..');
  const found = readdirSync(root)
    .filter((d) => d.startsWith('export_') && existsSync(join(root, d, 'activities.csv')))
    .map((d) => join(root, d))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return found[0] ?? null;
}

interface Activity { id: string; name: string; type: string | null; file: string | null; dist: number | null }

function listActivities(dir: string): { list: Activity[]; fromCsv: boolean } {
  if (!existsSync(dir)) throw new UsageError(`input folder not found: ${dir}`);
  if (!statSync(dir).isDirectory()) throw new UsageError(`input is not a folder: ${dir}`);
  const csvPath = join(dir, 'activities.csv');
  if (existsSync(csvPath)) {
    const rows = parseCsv(readFileSync(csvPath, 'utf8'));
    const h = rows[0] ?? [];
    const col = (name: string) => h.indexOf(name);
    const [cId, cName, cType, cFile] = ['Activity ID', 'Activity Name', 'Activity Type', 'Filename'].map(col);
    if (cId < 0 || cType < 0 || cFile < 0) {
      throw new UsageError(
        `activities.csv has no "Activity ID", "Activity Type" and "Filename" columns (found: ${h.slice(0, 4).join(', ')}…).\n`
        + 'The archive was probably exported with Strava set to another language. Set Strava to English and request the '
        + `archive again, or pass the activities folder (${join(dir, 'activities')}) to read the files without activities.csv.`);
    }
    // Strava has two "Distance" columns: the first in the display unit, the second in metres.
    const distCols = h.map((n, i) => (n === 'Distance' ? i : -1)).filter((i) => i >= 0);
    const cDist = distCols.length > 1 ? distCols[distCols.length - 1] : -1;
    const list = rows.slice(1).filter((r) => r.length > 1).map((r) => ({
      id: r[cId],
      name: cName >= 0 ? r[cName] : '',
      type: r[cType],
      file: r[cFile] ? join(dir, r[cFile]) : null,
      dist: cDist >= 0 && Number.isFinite(parseFloat(r[cDist])) ? parseFloat(r[cDist]) : null,
    }));
    return { list, fromCsv: true };
  }
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (formatOf(e)) files.push(p);
    }
  };
  walk(dir);
  files.sort();
  return {
    list: files.map((f) => {
      const id = basename(f).replace(/\.gz$/i, '').replace(/\.(fit|gpx|tcx)$/i, '');
      return { id, name: id, type: null, file: f, dist: null };
    }),
    fromCsv: false,
  };
}

export interface Summary {
  input: string;
  fromCsv: boolean;
  activities: number;
  read: number;
  parsed: number;
  homes: HomeCandidate[];
  kept: number;
  cutAtSignalLoss: number;
  truncated: number;
  points: number;
  years: [string, string] | null;
  skipped: [string, number][];
}

interface Candidate { act: Activity; track: Track }

/** Read, clean and encode the runs. Throws UsageError when nothing usable is left. Does not write. */
export function runIngest(o: Options): { file: RunsFile; summary: Summary } {
  const skipped = new Map<string, number>();
  const skip = (why: string) => skipped.set(why, (skipped.get(why) ?? 0) + 1);
  const sportOk = (s: string) => o.sport === 'any' || !s || s.toLowerCase().includes(o.sport);

  const { list, fromCsv } = listActivities(o.input);
  let read = 0;
  let parsed = 0;
  let truncated = 0;
  const seenFiles = new Set<string>();
  // Strava sometimes attaches the same track to several activities under different file names, so
  // duplicates are found by what the track contains, not by file name.
  const seenTracks = new Map<string, string>();
  const cands: Candidate[] = [];
  for (const act of list) {
    if (fromCsv && !sportOk(act.type ?? '')) { skip(`not a ${o.sport} (activity type)`); continue; }
    if (!act.file) { skip('no GPS file in export (manual or indoor activity)'); continue; }
    if (seenFiles.has(act.file)) { skip('duplicate track (same GPS data as an earlier activity)'); continue; }
    seenFiles.add(act.file);
    if (!existsSync(act.file)) { skip('file listed in activities.csv is missing'); continue; }
    if (!formatOf(act.file)) { skip('unsupported file format'); continue; }
    let raw;
    try {
      read++;
      raw = parseTrackBytes(new Uint8Array(readFileSync(act.file)), act.file);
    } catch (e) {
      skip(`parse error (${(e as Error).message.split('\n')[0].slice(0, 60)})`);
      continue;
    }
    parsed++;
    if (raw.truncated) truncated++;
    if (!fromCsv && !sportOk(raw.sport)) { skip(`not a ${o.sport} (sport in file)`); continue; }
    const tr = toTrack(raw);
    if (!tr) { skip('no GPS track (fewer than 10 timed points)'); continue; }
    const n = tr.t.length;
    const sig = `${tr.start}|${n}|${tr.lat[0]}|${tr.lon[0]}|${tr.lat[n - 1]}|${tr.lon[n - 1]}|${tr.t[n - 1]}`;
    if (seenTracks.has(sig)) { skip('duplicate track (same GPS data as an earlier activity)'); continue; }
    seenTracks.set(sig, act.id);
    const day = new Date(tr.start * 1000).toISOString().slice(0, 10);
    if ((o.since && day < o.since) || (o.until && day > o.until)) { skip('outside --since/--until'); continue; }
    const c = clean(tr, o.maxSpeed);
    if (c.t.length < 2) { skip('too few points after GPS cleaning'); continue; }
    cands.push({ act, track: c });
  }
  if (!cands.length) throw new UsageError('no timed GPS tracks of the requested sport and dates');

  // home candidates: every place with enough run starts, densest first; --home goes first
  const starts = cands.map((c): [number, number] => [c.track.lat[0], c.track.lon[0]]);
  const year = (i: number) => new Date(cands[i].track.start * 1000).getUTCFullYear();
  const candidate = (lat: number, lon: number, fromOption = false): HomeCandidate => {
    const near = starts.flatMap((s, i) => (distTo(s[0], s[1], [lat, lon]) <= o.radius ? [i] : []));
    const years = near.map(year);
    // id from the earliest run starting there: stable across re-ingests and says nothing about location
    const earliest = near.reduce((a, i) => (a < 0 || cands[i].track.start < cands[a].track.start ? i : a), -1);
    return {
      id: earliest >= 0 ? `h:${cands[earliest].act.id}` : `h:option:${lat},${lon}`,
      lat, lon, runs: near.length, first: years.length ? Math.min(...years) : 0, last: years.length ? Math.max(...years) : 0,
      ...(fromOption ? { fromOption } : {}),
    };
  };
  let homes = findHomes(starts, o.radius, o.minHomeRuns).map((h) => candidate(h.lat, h.lon));
  if (o.home) {
    const [lat, lon] = o.home;
    homes = [candidate(lat, lon, true), ...homes.filter((h) => distTo(h.lat, h.lon, o.home!) > o.radius)];
  }
  if (!homes.length) {
    throw new UsageError(`no place has ${o.minHomeRuns} or more runs starting within ${o.radius} m; `
      + 'try a larger --radius, a smaller --min-home-runs or --home lat,lon');
  }
  if (homes[0].runs === 0) {
    throw new UsageError(`no runs start within ${o.radius} m of --home ${o.home![0]},${o.home![1]}; try a larger --radius`);
  }

  // Every run with GPS is kept, so the page can show the runs of any home. With --privacy-radius every
  // run loses its start and end within that radius of where it began and ended and of every home, and
  // the homes are stored rounded to ~1 km.
  const homePoints = homes.map((h): [number, number] => [h.lat, h.lon]);
  const ref: [number, number] = [Math.round(homes[0].lon * 100) / 100, Math.round(homes[0].lat * 100) / 100];
  const runs: RunRecord[] = [];
  let points = 0;
  let cutAtSignalLoss = 0;
  for (const c of cands) {
    let tr: Track | null = c.track;
    if (o.privacyRadius > 0) {
      tr = hidePrivateEnds(tr, homePoints, o.privacyRadius);
      if (!tr) { skip('nothing left outside --privacy-radius'); continue; }
    }
    const animatedDist = pathLength(tr);
    tr = downsample(tr, o.minDt, o.minDist);
    points += tr.t.length;
    if (c.track.cut) cutAtSignalLoss++;
    runs.push({
      id: c.act.id,
      name: c.act.name,
      date: new Date(tr.start * 1000).toISOString().replace('.000Z', 'Z'),
      dist: Math.round(animatedDist),
      ...(c.act.dist !== null ? { csvDist: Math.round(c.act.dist) } : {}),
      dur: Math.round(tr.t[tr.t.length - 1]),
      p: encodePath(tr.lon, tr.lat, tr.t, ref, SCALE),
    });
  }
  if (o.privacyRadius > 0) {
    homes = homes.map((h) => ({ ...h, lat: Math.round(h.lat * 100) / 100, lon: Math.round(h.lon * 100) / 100 }));
    // the --home id would otherwise carry its exact coordinates
    homes = homes.map((h) => (h.id.startsWith('h:option:') ? { ...h, id: 'h:option' } : h));
  }
  if (!runs.length) throw new UsageError('no runs left after --privacy-radius trimming');
  runs.sort((a, b) => a.date.localeCompare(b.date));

  const file: RunsFile = {
    version: 2,
    generatedAt: new Date().toISOString(),
    scale: SCALE,
    ref,
    meta: {
      // trimmed starts and rounded homes are only approximate, so the page filters more loosely; the
      // default is fixed so it says nothing about the privacy radius
      radius: o.privacyRadius > 0 ? Math.max(PRIVATE_DEFAULT_RADIUS, o.radius) : o.radius,
      privacyTrimmed: o.privacyRadius > 0, homes, homeSpacing: o.homeSpacing, maxSpeed: o.maxSpeed, sport: o.sport,
      since: o.since, until: o.until,
    },
    runs,
  };
  return {
    file,
    summary: {
      input: o.input, fromCsv, activities: list.length, read, parsed, homes,
      kept: runs.length, cutAtSignalLoss, truncated, points,
      years: [runs[0].date.slice(0, 4), runs[runs.length - 1].date.slice(0, 4)],
      skipped: [...skipped].sort((a, b) => b[1] - a[1]),
    },
  };
}

/**
 * Write atomically: into a temp file next to the output, then rename. On any failure the temp file
 * (which holds GPS data) is removed and an existing output is left as it was.
 */
export function writeRuns(out: string, file: RunsFile): number {
  const json = JSON.stringify(file);
  const tmp = join(dirname(out), `.${basename(out)}.tmp-${process.pid}`);
  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(tmp, json);
    renameSync(tmp, out);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean up */ }
    throw new IoError(`could not write ${out}: ${(e as Error).message}`);
  }
  return json.length;
}

export function formatSummary(s: Summary, radius: number, out: string, bytes: number, spacing = 1000): string {
  const groups = groupHomes(s.homes, spacing);
  const lines = [
    `input:         ${s.input}${s.fromCsv ? ' (activities.csv)' : ' (file scan)'}`,
    `activities:    ${s.activities}`,
    `files read:    ${s.read}`,
    `parsed:        ${s.parsed}`,
    `runs kept:     ${s.kept} with GPS${s.years ? ` (${s.years[0]}-${s.years[1]})` : ''}`,
    `homes:         ${s.homes.length} (places with runs starting within ${radius} m)`,
    ...s.homes.map((h, i) => `  ${String(i + 1).padStart(3)}. ${h.lat.toFixed(4)}, ${h.lon.toFixed(4)} · ${h.runs} runs · `
      + `${h.first === h.last ? h.first : `${h.first}-${h.last}`}${h.fromOption ? ' (--home)' : ''}`
      + (groups[i] === null ? '' : ` (start spot near ${groups[i]! + 1})`)),
    `cut at signal loss: ${s.cutAtSignalLoss} of the kept runs`,
    ...(s.truncated ? [`truncated:     ${s.truncated} files (partial data kept)`] : []),
    `points:        ${s.points}`,
    'skipped:',
    ...s.skipped.map(([why, n]) => `  ${String(n).padStart(5)}  ${why}`),
    `wrote:         ${out} (${(bytes / 1e6).toFixed(2)} MB)`,
  ];
  return lines.join('\n');
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const o = parseArgs(argv);
    const { file, summary } = runIngest(o);
    const bytes = writeRuns(o.out, file);
    console.log(formatSummary(summary, o.radius, o.out, bytes, o.homeSpacing));
    return 0;
  } catch (e) {
    if (e instanceof IoError) {
      console.error(`error: ${e.message}`);
      return 1;
    }
    if (e instanceof UsageError) {
      if (e.message) console.error(`error: ${e.message}\n`);
      console.error(USAGE);
      return e.message ? 2 : 0;
    }
    throw e;
  }
}

if (import.meta.main) process.exit(main());
