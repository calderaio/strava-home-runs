/**
 * Bookkeeping of failed map tiles: a tile is a gap from the moment its request fails until it
 * loads. Only tiles at the zoom the map draws now that overlap the view count as gaps.
 */
export interface TileId { x: number; y: number; z: number }
export interface Bounds { west: number; south: number; east: number; north: number }

const key = (source: string, t: TileId) => `${source}/${t.z}/${t.x}/${t.y}`;
const lonOfX = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const latOfY = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

export class TileFailures {
  private failed = new Map<string, { source: string } & TileId>();

  fail(source: string, t: TileId) { this.failed.set(key(source, t), { source, x: t.x, y: t.y, z: t.z }); }
  /** Returns true if the tile had failed before (it has now recovered). */
  loaded(source: string, t: TileId): boolean { return this.failed.delete(key(source, t)); }
  get size() { return this.failed.size; }

  /** Failed tiles that leave a gap in a view at `zoom` (capped per source by `maxzoom`). */
  inView(bounds: Bounds, zoom: number, maxzoom: (source: string) => number): Map<string, TileId[]> {
    const out = new Map<string, TileId[]>();
    const z = Math.floor(zoom);
    for (const t of this.failed.values()) {
      if (t.z !== Math.min(z, maxzoom(t.source))) continue; // another zoom: no longer drawn
      const w = lonOfX(t.x, t.z), e = lonOfX(t.x + 1, t.z), n = latOfY(t.y, t.z), s = latOfY(t.y + 1, t.z);
      if (e < bounds.west || w > bounds.east || n < bounds.south || s > bounds.north) continue;
      const list = out.get(t.source) ?? [];
      list.push({ x: t.x, y: t.y, z: t.z });
      out.set(t.source, list);
    }
    return out;
  }
}
