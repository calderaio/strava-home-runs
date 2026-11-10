import { describe, expect, test } from 'bun:test';
import { decodePath, encodePath } from '../src/lib/format.ts';
import { computeCameraTrack } from '../src/lib/camera.ts';
import { HOME, REF, run } from './fixtures.ts';

describe('runs file format', () => {
  test('delta encoding round-trips to ~1 m without drift', () => {
    const n = 2000;
    const lon = Array.from({ length: n }, (_, i) => HOME[1] + Math.sin(i / 50) * 0.01 + i * 1.3e-6);
    const lat = Array.from({ length: n }, (_, i) => HOME[0] + Math.cos(i / 70) * 0.01);
    const t = Array.from({ length: n }, (_, i) => i * 5.2);
    const p = encodePath(lon, lat, t, REF, 1e5);
    expect(p.length).toBe(n * 3);
    expect(p.every(Number.isInteger)).toBe(true);
    const d = decodePath(p, REF, 1e5);
    for (let i = 0; i < n; i++) {
      expect(Math.abs(d.lonlat[2 * i] - lon[i])).toBeLessThanOrEqual(0.5e-5 + 1e-12);
      expect(Math.abs(d.lonlat[2 * i + 1] - lat[i])).toBeLessThanOrEqual(0.5e-5 + 1e-12);
      expect(Math.abs(d.t[i] - t[i])).toBeLessThanOrEqual(0.5);
    }
  });
});

describe('camera', () => {
  test('zooms out monotonically as routes grow', () => {
    const [la, lo] = HOME;
    const r1 = run([lo, la, lo + 0.02, la], [0, 1000]);
    const r2 = run([lo, la, lo, la + 0.05], [0, 3000]);
    const clock = Float64Array.from({ length: 300 }, (_, f) => f * 10);
    const cam = computeCameraTrack([r1, r2], clock, { width: 540, height: 960, pad: { top: 230, bottom: 278, left: 36, right: 36 } });
    for (let f = 1; f < 300; f++) expect(cam.zoom[f]).toBeLessThanOrEqual(cam.zoom[f - 1] + 1e-12);
    expect(cam.zoom[0] - cam.zoom[299]).toBeGreaterThan(1);
  });
});
