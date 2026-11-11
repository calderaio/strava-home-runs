import { describe, expect, test } from 'bun:test';
import { candidateId, customId, defaultPrefs, loadPrefs, PREFS_KEY, savePrefs } from '../src/lib/prefs.ts';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};
const broken = {
  getItem: () => { throw new DOMException('blocked', 'SecurityError'); },
  setItem: () => { throw new DOMException('full', 'QuotaExceededError'); },
};

describe('preferences', () => {
  test('round-trip names, selection, picked homes and privacy radius', () => {
    const s = memory();
    const p = { ...defaultPrefs(), names: { [candidateId(-20, -140)]: 'Harbour' }, selected: customId(-20.1, -140.2), privacyRadius: 250,
      custom: [{ id: customId(-20.1, -140.2), lat: -20.1, lon: -140.2 }] };
    expect(savePrefs(p, s)).toBe(true);
    expect(loadPrefs(s)).toEqual(p);
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
    s.m.set(PREFS_KEY, JSON.stringify({ names: { a: 'ok', b: 5 }, selected: 7, privacyRadius: -3,
      custom: [{ id: 'u:1', lat: 1, lon: 2 }, { id: 'u:2', lat: 'x', lon: 2 }, { id: 'u:3', lat: 95, lon: 0 }, null] }));
    expect(loadPrefs(s)).toEqual({ names: { a: 'ok' }, selected: null, custom: [{ id: 'u:1', lat: 1, lon: 2 }], privacyRadius: 0 });
  });

  test('ids are stable across re-ingests (rounded coordinates)', () => {
    expect(candidateId(-20.000001, -140.000004)).toBe(candidateId(-20, -140));
    expect(customId(-20.123456, -140.654321)).toBe('u:-20.12346,-140.65432');
  });
});
