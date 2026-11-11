import { describe, expect, test } from 'bun:test';
import { TileFailures } from '../src/lib/tiles.ts';

// tile 12/0/0 is the north-west corner; a view over it and one far away
const corner = { west: -180, south: 84, east: -179.9, north: 85 };
const elsewhere = { west: 10, south: -10, east: 11, north: -9 };
const max15 = () => 15;

describe('failed tiles', () => {
  test('a failed tile is a gap in a view over it at its zoom, until it loads', () => {
    const f = new TileFailures();
    f.fail('carto', { z: 12, x: 0, y: 0 });
    expect(f.inView(corner, 12.7, max15).get('carto')).toEqual([{ z: 12, x: 0, y: 0 }]);
    expect(f.inView(elsewhere, 12.7, max15).size).toBe(0);
    expect(f.loaded('carto', { z: 12, x: 0, y: 0 })).toBe(true);
    expect(f.inView(corner, 12.7, max15).size).toBe(0);
    expect(f.size).toBe(0);
    expect(f.loaded('carto', { z: 12, x: 0, y: 0 })).toBe(false);
  });

  test('tiles from another zoom are not gaps; the max zoom caps the zoom that is drawn', () => {
    const f = new TileFailures();
    f.fail('carto', { z: 11, x: 0, y: 0 });
    expect(f.inView(corner, 12.2, max15).size).toBe(0);
    expect(f.inView(corner, 11.9, max15).size).toBe(1);
    f.fail('carto', { z: 15, x: 0, y: 0 });
    expect(f.inView({ ...corner, east: -179.99 }, 17.5, max15).get('carto')).toEqual([{ z: 15, x: 0, y: 0 }]);
  });
});
