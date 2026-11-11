import { distToHome } from './runs.ts';

interface Place { lat: number; lon: number; runs: number; fromOption?: boolean }

/**
 * Which candidates are homes and which are nearby start spots. A candidate closer than `spacing`
 * metres to a larger one (more runs; a --home one counts as largest) is a spot; it is grouped under
 * the nearest larger home. Returns, per candidate, null for a home or the index of its home.
 */
export function groupHomes(homes: Place[], spacing: number): (number | null)[] {
  const order = homes.map((_, i) => i).sort((a, b) =>
    Number(!!homes[b].fromOption) - Number(!!homes[a].fromOption) || homes[b].runs - homes[a].runs || a - b);
  const parent: (number | null)[] = homes.map(() => null);
  const done: number[] = [];
  for (const i of order) {
    let nearest = -1;
    let best = Infinity;
    for (const j of done) {
      const d = distToHome(homes[i].lon, homes[i].lat, homes[j]);
      if (d < spacing && d < best) { best = d; nearest = j; }
    }
    if (nearest >= 0) parent[i] = parent[nearest] ?? nearest;
    done.push(i);
  }
  return parent;
}
