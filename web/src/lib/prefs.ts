/**
 * Per-browser preferences: home names, the last selected home and homes picked on the map.
 * Stored in localStorage; every access is wrapped, so a blocked or broken storage (private mode,
 * disabled site data, quota) only means the preferences are not remembered.
 */
export interface CustomHome { id: string; lat: number; lon: number }

export interface Prefs {
  names: Record<string, string>; // home id -> name
  selected: string | null;       // home id
  custom: CustomHome[];
  privacyRadius: number;
}

export const PREFS_KEY = 'home-runs.prefs.v1';

export const defaultPrefs = (): Prefs => ({ names: {}, selected: null, custom: [], privacyRadius: 0 });

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function browserStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // accessing localStorage itself can throw (blocked site data)
  }
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function loadPrefs(storage: StorageLike | null = browserStorage()): Prefs {
  const p = defaultPrefs();
  try {
    const raw = storage?.getItem(PREFS_KEY);
    if (!raw) return p;
    const v = JSON.parse(raw) as Partial<Prefs>;
    if (v && typeof v.names === 'object' && v.names) {
      for (const [k, n] of Object.entries(v.names)) if (typeof n === 'string') p.names[k] = n.slice(0, 80);
    }
    if (typeof v.selected === 'string') p.selected = v.selected;
    if (Array.isArray(v.custom)) {
      p.custom = v.custom.filter((c): c is CustomHome => !!c && typeof c.id === 'string' && isFiniteNum(c.lat) && isFiniteNum(c.lon)
        && Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180);
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

export const candidateId = (lat: number, lon: number) => `c:${lat.toFixed(4)},${lon.toFixed(4)}`;
export const customId = (lat: number, lon: number) => `u:${lat.toFixed(5)},${lon.toFixed(5)}`;
