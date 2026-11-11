import { describe, expect, test } from 'bun:test';
import { mp4Layout } from '../scripts/mp4.ts';

const box = (type: string, body: Uint8Array = new Uint8Array(0)) => {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
};
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const mvhd0 = (timescale: number, duration: number) => {
  const b = new Uint8Array(100);
  const dv = new DataView(b.buffer);
  dv.setUint32(12, timescale); // after version/flags (4), creation (4), modification (4)
  dv.setUint32(16, duration);
  return box('mvhd', b);
};
const mvhd1 = (timescale: number, duration: number) => {
  const b = new Uint8Array(112);
  const dv = new DataView(b.buffer);
  b[0] = 1;
  dv.setUint32(20, timescale); // after version/flags (4), creation (8), modification (8)
  dv.setBigUint64(24, BigInt(duration));
  return box('mvhd', b);
};

describe('mp4 layout', () => {
  test('moov before mdat is fast start, and the duration comes from mvhd', () => {
    const f = cat(box('ftyp', new Uint8Array(8)), box('moov', cat(mvhd0(1000, 36500), box('trak'))), box('mdat', new Uint8Array(50)));
    expect(mp4Layout(f)).toEqual({ boxes: ['ftyp', 'moov', 'mdat'], fastStart: true, duration: 36.5 });
  });

  test('moov after mdat is not fast start; version 1 mvhd works', () => {
    const f = cat(box('ftyp'), box('mdat', new Uint8Array(20)), box('moov', mvhd1(90000, 90000 * 12)));
    expect(mp4Layout(f)).toEqual({ boxes: ['ftyp', 'mdat', 'moov'], fastStart: false, duration: 12 });
  });

  test('a missing moov is not fast start; a box running past the end is an error', () => {
    expect(mp4Layout(cat(box('ftyp'), box('mdat'))).fastStart).toBe(false);
    expect(Number.isNaN(mp4Layout(cat(box('ftyp'), box('mdat'))).duration)).toBe(true);
    const broken = box('mdat', new Uint8Array(10));
    new DataView(broken.buffer).setUint32(0, 999);
    expect(() => mp4Layout(cat(box('ftyp'), broken))).toThrow(/broken MP4 box "mdat"/);
  });
});
