import { describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { parseGpx, parseTcx, parseTrackBytes, toTrack } from '../ingest/track.ts';
import { gpx, HOME, line } from './fixtures.ts';

const pts = Array.from({ length: 12 }, (_, i) => ({ lat: HOME[0] + i * 1e-4, lon: HOME[1] + i * 2e-4, t: `2024-05-01T07:00:${String(i * 2).padStart(2, '0')}Z` }));

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="StravaGPX" version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
 <metadata><time>2024-05-01T07:00:00Z</time></metadata>
 <trk><name>Morning Run</name><type>running</type><trkseg>
  <trkpt lat="-21.0" lon="-141.0"/>
  ${pts.map((p, i) => (i % 2
    ? `<trkpt lon='${p.lon}' lat='${p.lat}'><ele>410</ele><time>${p.t}</time></trkpt>`
    : `<trkpt lat="${p.lat}" lon="${p.lon}">\n   <ele>410.2</ele>\n   <time>${p.t}</time>\n  </trkpt>`)).join('\n  ')}
  <trkpt lat="-19.5" lon="-139.5"><ele>1</ele></trkpt>
 </trkseg></trk>
</gpx>`;

const TCX = `  <?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
 <Activities><Activity Sport="Running"><Id>2024-05-01T07:00:00Z</Id><Lap><Track>
 ${pts.map((p) => `<Trackpoint><Time>${p.t}</Time><Position><LatitudeDegrees>${p.lat}</LatitudeDegrees><LongitudeDegrees>${p.lon}</LongitudeDegrees></Position></Trackpoint>`).join('\n ')}
 <Trackpoint><Time>2024-05-01T07:01:00Z</Time><HeartRateBpm><Value>150</Value></HeartRateBpm></Trackpoint>
 </Track></Lap></Activity></Activities>
</TrainingCenterDatabase>`;

describe('GPX / TCX', () => {
  test('GPX: timed points only, either attribute order, sport from <type>', () => {
    const r = parseGpx(GPX);
    expect(r.sport).toBe('running');
    expect(r.lat.length).toBe(12);
    expect(r.lat[3]).toBeCloseTo(pts[3].lat, 9);
    expect(r.lon[3]).toBeCloseTo(pts[3].lon, 9);
    expect(r.time[1] - r.time[0]).toBe(2);
    expect(r.time[0]).toBe(Date.parse('2024-05-01T07:00:00Z') / 1000);
  });

  test('namespaced GPX and times without a zone (taken as UTC, even in another local time zone)', () => {
    const saved = process.env.TZ;
    process.env.TZ = 'Pacific/Auckland';
    try {
      expect(new Date(2024, 4, 1).getTimezoneOffset()).not.toBe(0); // the zone change took effect
      const ns = GPX.replace(/<(\/?)(gpx|trk|trkseg|trkpt|time|type)\b/g, '<$1g:$2').replace(/Z<\/g:time>/g, '</g:time>');
      const r = parseGpx(ns);
      expect(r.lat.length).toBe(12);
      expect(r.time[0]).toBe(Date.UTC(2024, 4, 1, 7, 0, 0) / 1000);
      // explicit offsets are honoured
      const T = Date.UTC(2024, 4, 1, 7, 0, 0) / 1000;
      const local = gpx(line(12, T)).replace(/\.000Z<\/time>/g, '.000+02:00</time>');
      expect(local).toContain('+02:00</time>');
      expect(parseGpx(local).time[0]).toBe(T - 7200);
    } finally {
      if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
    }
  });

  test('gzipped GPX via parseTrackBytes', () => {
    const r = parseTrackBytes(gzipSync(new TextEncoder().encode(GPX)), 'a.gpx.gz');
    expect(r.lat.length).toBe(12);
    const tr = toTrack(r)!;
    expect(tr.t[0]).toBe(0);
    expect(tr.t[11]).toBe(22);
  });

  test('TCX (leading whitespace, untimed / unpositioned points ignored), sniffed without extension', () => {
    expect(parseTcx(TCX).lat.length).toBe(12);
    const r = parseTrackBytes(new TextEncoder().encode(TCX), 'file');
    expect(r.sport).toBe('running');
    expect(r.lon[11]).toBeCloseTo(pts[11].lon, 9);
  });

  test('points with unset clocks (before 2000) are dropped before the start time is taken', () => {
    const r = parseGpx(GPX);
    r.time[0] = 631065600; // FIT epoch, as reported by a device without a clock fix
    r.time[1] = Number.NaN;
    const tr = toTrack(r)!;
    expect(tr.t.length).toBe(10);
    expect(tr.start).toBe(Date.parse(pts[2].t) / 1000);
    expect(tr.t[0]).toBe(0);
  });

  test('too few points gives no track', () => {
    expect(toTrack({ lat: [1, 2], lon: [1, 2], time: [0, 1], sport: '' })).toBeNull();
    expect(() => parseTrackBytes(new TextEncoder().encode('hello'), 'x.txt')).toThrow();
  });
});
