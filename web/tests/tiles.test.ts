import { describe, expect, test } from 'bun:test';
import { TileFailures } from '../src/lib/tiles.ts';

// Tiles just south-east of (0, 0): at zoom z, tile x = y = 2^(z-1) spans lon 0..360/2^z and lat 0..-(about the same).
// z12 tile 2048/2048: lon 0..0.0879, lat -0.0879..0. z11 tile 1024/1024: lon 0..0.176. z15 tile 16384/16384: lon 0..0.011.
const t12 = { z: 12, x: 2048, y: 2048 };
const t11 = { z: 11, x: 1024, y: 1024 };
const t15 = { z: 15, x: 16384, y: 16384 };
const over = { west: 0.01, south: -0.02, east: 0.02, north: -0.01 };  // inside all three tiles
const elsewhere = { west: 10, south: -10, east: 11, north: -9 };
const westOf = { west: -0.02, south: -0.02, east: -0.001, north: -0.01 }; // just outside them
const max15 = () => 15;

describe('failed tiles', () => {
  test('a failed tile is a gap in a view over it at its zoom, until it loads', () => {
    const f = new TileFailures();
    f.fail('carto', t12);
    expect(f.inView(over, 12.7, max15).get('carto')).toEqual([t12]);
    expect(f.inView(elsewhere, 12.7, max15).size).toBe(0);
    expect(f.inView(westOf, 12.7, max15).size).toBe(0);
    expect(f.loaded('carto', t12)).toBe(true);
    expect(f.inView(over, 12.7, max15).size).toBe(0);
    expect(f.size).toBe(0);
    expect(f.loaded('carto', t12)).toBe(false);
  });

  test('tiles from another zoom are not gaps; the max zoom caps the zoom that is drawn', () => {
    const f = new TileFailures();
    f.fail('carto', t11);
    expect(f.inView(over, 12.2, max15).size).toBe(0);
    expect(f.inView(over, 11.9, max15).get('carto')).toEqual([t11]);
    f.fail('carto', t15);
    expect(f.inView(over, 17.5, max15).get('carto')).toEqual([t15]);
    expect(f.inView(over, 14.5, max15).size).toBe(0);
  });

  test('sources are kept apart', () => {
    const f = new TileFailures();
    f.fail('a', t12);
    expect(f.loaded('b', t12)).toBe(false);
    expect(f.inView(over, 12, max15).get('a')).toEqual([t12]);
  });
});
