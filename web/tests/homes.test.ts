import { describe, expect, test } from 'bun:test';
import { groupHomes } from '../src/lib/homes.ts';
import { offset } from './fixtures.ts';

const place = (east: number, runs: number, fromOption = false) => {
  const [lat, lon] = offset(east);
  return { lat, lon, runs, ...(fromOption ? { fromOption } : {}) };
};

describe('homes and nearby start spots', () => {
  test('a candidate closer than the spacing to a larger one is a spot of the nearest larger home', () => {
    const homes = [place(0, 400), place(5000, 60), place(600, 20), place(5900, 15), place(999, 12), place(2500, 11)];
    expect(groupHomes(homes, 1000)).toEqual([null, null, 0, 1, 0, null]); // 2500 is ≥ 1000 m from every larger one
  });

  test('exactly the spacing away is a home; a spot near a spot goes under that spot\'s home; spacing 0 makes all homes', () => {
    expect(groupHomes([place(0, 100), place(1000, 50)], 1000)).toEqual([null, null]);
    const homes = [place(0, 100), place(800, 50), place(1500, 20)];
    expect(groupHomes(homes, 1000)).toEqual([null, 0, 0]);
    expect(groupHomes(homes, 0)).toEqual([null, null, null]);
  });

  test('the larger one wins regardless of order, and --home counts as largest', () => {
    expect(groupHomes([place(600, 20), place(0, 400)], 1000)).toEqual([1, null]);
    expect(groupHomes([place(600, 3, true), place(0, 400)], 1000)).toEqual([null, 0]);
  });
});
