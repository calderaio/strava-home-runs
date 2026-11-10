/**
 * Minimal FIT decoder: reads GPS records (lat, lon, timestamp) and the sport.
 *
 * Handles normal and compressed-timestamp record headers, little/big-endian definitions,
 * developer fields (skipped) and chained FIT files. Other messages are skipped by size.
 */
import type { RawTrack } from './track.ts';

const FIT_EPOCH = 631065600; // 1989-12-31T00:00:00Z in unix seconds
const SEMI = 180 / 2 ** 31;
const MSG_RECORD = 20;
const MSG_SESSION = 18;
const MSG_SPORT = 12;
const SPORTS: Record<number, string> = {
  0: 'generic', 1: 'running', 2: 'cycling', 3: 'transition', 4: 'fitness_equipment', 5: 'swimming',
  10: 'training', 11: 'walking', 13: 'alpine_skiing', 15: 'rowing', 17: 'hiking', 21: 'e_biking',
};

interface FieldDef { num: number; size: number }
interface MsgDef { global: number; little: boolean; fields: FieldDef[]; devSize: number }

export function isFit(buf: Uint8Array): boolean {
  return buf.length >= 12 && buf[8] === 0x2e && buf[9] === 0x46 && buf[10] === 0x49 && buf[11] === 0x54; // ".FIT"
}

export function parseFit(buf: Uint8Array): RawTrack {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const lat: number[] = [];
  const lon: number[] = [];
  const time: number[] = [];
  let sport = '';
  let off = 0;
  let files = 0;
  let truncated = false;
  while (off + 12 <= buf.length && isFit(buf.subarray(off))) {
    const headerSize = buf[off];
    const dataSize = dv.getUint32(off + 4, true);
    const start = off + headerSize;
    const end = Math.min(start + dataSize, buf.length);
    if (start + dataSize > buf.length) truncated = true;
    const r = parseFile(dv, start, end, lat, lon, time);
    sport = r.sport || sport;
    truncated ||= r.truncated;
    off = start + dataSize + 2; // skip CRC
    files++;
  }
  if (!files) throw new Error('not a FIT file');
  return { lat, lon, time, sport, ...(truncated ? { truncated } : {}) };
}

/**
 * Decode one FIT file's records. A truncated or corrupt file stops the decode but keeps the records
 * read so far; it only throws if nothing usable was read.
 */
function parseFile(dv: DataView, start: number, end: number, lat: number[], lon: number[], time: number[]):
  { sport: string; truncated: boolean } {
  const before = lat.length;
  try {
    return { sport: decode(dv, start, end, lat, lon, time), truncated: false };
  } catch (e) {
    if (lat.length > before) return { sport: (e as { sport?: string }).sport ?? '', truncated: true };
    throw e;
  }
}

class FitError extends Error {
  constructor(msg: string, readonly sport: string) { super(msg); }
}

function decode(dv: DataView, start: number, end: number, lat: number[], lon: number[], time: number[]): string {
  const defs: (MsgDef | undefined)[] = new Array(16);
  let lastTs = 0;
  let sport = '';
  let p = start;
  while (p < end) {
    const h = dv.getUint8(p++);
    if (h & 0x40 && !(h & 0x80)) {
      // definition message
      if (p + 5 > end) throw new FitError('FIT: truncated definition', sport);
      const local = h & 0x0f;
      const little = dv.getUint8(p + 1) === 0;
      const global = dv.getUint16(p + 2, little);
      const n = dv.getUint8(p + 4);
      p += 5;
      if (p + 3 * n + (h & 0x20 ? 1 : 0) > end) throw new FitError('FIT: truncated definition', sport);
      const fields: FieldDef[] = [];
      for (let i = 0; i < n; i++) {
        fields.push({ num: dv.getUint8(p), size: dv.getUint8(p + 1) });
        p += 3;
      }
      let devSize = 0;
      if (h & 0x20) {
        const nd = dv.getUint8(p++);
        if (p + 3 * nd > end) throw new FitError('FIT: truncated definition', sport);
        for (let i = 0; i < nd; i++) {
          devSize += dv.getUint8(p + 1);
          p += 3;
        }
      }
      defs[local] = { global, little, fields, devSize };
      continue;
    }
    let local: number;
    let ts = -1;
    if (h & 0x80) {
      // compressed timestamp header
      local = (h >> 5) & 0x03;
      const offset = h & 0x1f;
      ts = lastTs + ((offset - (lastTs & 0x1f)) & 0x1f);
      lastTs = ts;
    } else {
      local = h & 0x0f;
    }
    const def = defs[local];
    if (!def) throw new FitError(`FIT: data message for undefined local type ${local} at byte ${p - 1}`, sport);
    let la = 0x7fffffff;
    let lo = 0x7fffffff;
    for (const f of def.fields) {
      if (p + f.size > end) throw new FitError('FIT: truncated message', sport);
      if (f.num === 253 && f.size === 4) {
        const v = dv.getUint32(p, def.little);
        if (v !== 0xffffffff) { ts = v; lastTs = v; }
      } else if (def.global === MSG_RECORD && f.size === 4 && (f.num === 0 || f.num === 1)) {
        const v = dv.getInt32(p, def.little);
        if (f.num === 0) la = v; else lo = v;
      } else if (((def.global === MSG_SESSION && f.num === 5) || (def.global === MSG_SPORT && f.num === 0)) && f.size >= 1) {
        const v = dv.getUint8(p);
        if (v !== 0xff && !sport) sport = SPORTS[v] ?? `sport_${v}`;
      }
      p += f.size;
    }
    p += def.devSize;
    if (def.global === MSG_RECORD && ts >= 0 && la !== 0x7fffffff && lo !== 0x7fffffff && !(la === 0 && lo === 0)) {
      lat.push(la * SEMI);
      lon.push(lo * SEMI);
      time.push(ts + FIT_EPOCH);
    }
  }
  return sport;
}
