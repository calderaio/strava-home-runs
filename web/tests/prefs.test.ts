import { describe, expect, test } from 'bun:test';
import { customId, dataPrefs, defaultPrefs, loadPrefs, PREFS_KEY, savePrefs } from '../src/lib/prefs.ts';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};
const broken = {
  getItem: () => { throw new DOMException('blocked', 'SecurityError'); },
  setItem: () => { throw new DOMException('full', 'QuotaExceededError'); },
};

describe('preferences', () => {
  test('round-trip names, radii, per-data selection and picked homes, privacy radius', () => {
    const s = memory();
    const p = defaultPrefs();
    p.names['h:123'] = 'Harbour';
    p.radii['h:123'] = 350;
    p.privacyRadius = 250;
    const d = dataPrefs(p, 'runs:1');
    d.selected = customId(-20.1, -140.2);
    d.custom.push({ id: customId(-20.1, -140.2), lat: -20.1, lon: -140.2 });
    expect(savePrefs(p, s)).toBe(true);
    expect(loadPrefs(s)).toEqual(p);
  });

  test('picked homes and the selection belong to one data file', () => {
    const p = defaultPrefs();
    dataPrefs(p, 'runs:A').custom.push({ id: 'u:1', lat: 1, lon: 2 });
    dataPrefs(p, 'runs:A').selected = 'u:1';
    expect(dataPrefs(p, 'runs:B')).toEqual({ selected: null, custom: [] });
    expect(dataPrefs(p, 'runs:A').custom.length).toBe(1);
  });

  test('a throwing or missing storage falls back to defaults and reports that it could not save', () => {
    expect(loadPrefs(broken)).toEqual(defaultPrefs());
    expect(savePrefs(defaultPrefs(), broken)).toBe(false);
    expect(loadPrefs(null)).toEqual(defaultPrefs());
    expect(savePrefs(defaultPrefs(), null)).toBe(false);
  });

  test('corrupt or hostile stored data is ignored field by field', () => {
    const s = memory();
    s.m.set(PREFS_KEY, '{not json');
    expect(loadPrefs(s)).toEqual(defaultPrefs());
    s.m.set(PREFS_KEY, JSON.stringify({
      names: { a: 'ok', b: 5 }, radii: { a: 300, b: -1, c: 'x' }, privacyRadius: -3,
      data: { fp: { selected: 7, custom: [{ id: 'u:1', lat: 1, lon: 2 }, { id: 'u:2', lat: 'x', lon: 2 }, { id: 'u:3', lat: 95, lon: 0 }, null] }, bad: 5 },
    }));
    expect(loadPrefs(s)).toEqual({ names: { a: 'ok' }, radii: { a: 300 }, privacyRadius: 0,
      data: { fp: { selected: null, custom: [{ id: 'u:1', lat: 1, lon: 2 }] } } });
  });

  test('picked-home ids round to ~1 m', () => {
    expect(customId(-20.123456, -140.654321)).toBe('u:-20.12346,-140.65432');
  });
});
