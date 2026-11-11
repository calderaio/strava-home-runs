/**
 * Per-browser preferences: home names, start radius per home, the last selected home and homes
 * picked on the map. Selection and picked homes belong to one data file (keyed by a fingerprint),
 * so picks made for one export don't show up with another. Stored in localStorage; every access is
 * wrapped, so a blocked or broken storage (private mode, disabled site data, quota) only means the
 * preferences are not remembered.
 */
export interface CustomHome { id: string; lat: number; lon: number }

export interface DataPrefs {
  selected: string | null; // home id
  custom: CustomHome[];
}

export interface Prefs {
  names: Record<string, string>;  // home id -> name
  radii: Record<string, number>;  // home id -> start radius (m)
  data: Record<string, DataPrefs>; // data fingerprint -> selection and picked homes
  privacyRadius: number;
}

export const PREFS_KEY = 'home-runs.prefs.v2';

export const defaultPrefs = (): Prefs => ({ names: {}, radii: {}, data: {}, privacyRadius: 0 });

/** The selection and picked homes for one data file, created on first use. */
export function dataPrefs(p: Prefs, fingerprint: string): DataPrefs {
  return (p.data[fingerprint] ??= { selected: null, custom: [] });
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function browserStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // accessing localStorage itself can throw (blocked site data)
  }
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function readCustom(v: unknown): CustomHome[] {
  if (!Array.isArray(v)) return [];
  return v.filter((c): c is CustomHome => isObj(c) && typeof c.id === 'string' && isFiniteNum(c.lat) && isFiniteNum(c.lon)
    && Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180).map((c) => ({ id: c.id, lat: c.lat, lon: c.lon }));
}

export function loadPrefs(storage: StorageLike | null = browserStorage()): Prefs {
  const p = defaultPrefs();
  try {
    const raw = storage?.getItem(PREFS_KEY);
    if (!raw) return p;
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (isObj(v.names)) for (const [k, n] of Object.entries(v.names)) if (typeof n === 'string') p.names[k] = n.slice(0, 80);
    if (isObj(v.radii)) for (const [k, r] of Object.entries(v.radii)) if (isFiniteNum(r) && r > 0) p.radii[k] = r;
    if (isObj(v.data)) {
      for (const [fp, d] of Object.entries(v.data)) {
        if (!isObj(d)) continue;
        p.data[fp] = { selected: typeof d.selected === 'string' ? d.selected : null, custom: readCustom(d.custom) };
      }
    }
    if (isFiniteNum(v.privacyRadius) && v.privacyRadius >= 0) p.privacyRadius = v.privacyRadius;
  } catch {
    return defaultPrefs(); // unreadable or corrupt: start fresh
  }
  return p;
}

/** Returns false when the preferences could not be stored. */
export function savePrefs(p: Prefs, storage: StorageLike | null = browserStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(PREFS_KEY, JSON.stringify(p));
    return true;
  } catch {
    return false;
  }
}

export const customId = (lat: number, lon: number) => `u:${lat.toFixed(5)},${lon.toFixed(5)}`;
