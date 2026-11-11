/**
 * Reads the top-level box layout of an MP4 file: whether `moov` comes before `mdat` ("fast start",
 * so a player can start before the whole file has arrived) and the duration from `mvhd`.
 */
export interface Mp4Layout {
  boxes: string[];     // top-level box types in file order
  fastStart: boolean;  // moov before mdat
  duration: number;    // seconds, from moov/mvhd (NaN if missing)
}

export function mp4Layout(buf: Uint8Array): Mp4Layout {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const type = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  const boxes: string[] = [];
  let duration = NaN;
  let o = 0;
  while (o + 8 <= buf.length) {
    let size = dv.getUint32(o);
    const t = type(o + 4);
    let header = 8;
    if (size === 1) {
      if (o + 16 > buf.length) break;
      size = Number(dv.getBigUint64(o + 8));
      header = 16;
    } else if (size === 0) {
      size = buf.length - o; // runs to the end of the file
    }
    if (size < header || o + size > buf.length) throw new Error(`broken MP4 box "${t}" at byte ${o}`);
    boxes.push(t);
    if (t === 'moov') duration = mvhdDuration(buf, dv, o + header, o + size);
    o += size;
  }
  const moov = boxes.indexOf('moov');
  const mdat = boxes.indexOf('mdat');
  return { boxes, fastStart: moov >= 0 && mdat >= 0 && moov < mdat, duration };
}

function mvhdDuration(buf: Uint8Array, dv: DataView, start: number, end: number): number {
  let o = start;
  while (o + 8 <= end) {
    const size = dv.getUint32(o);
    const t = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
    if (size < 8) break;
    if (t === 'mvhd') {
      const version = buf[o + 8];
      if (version === 1) return Number(dv.getBigUint64(o + 32)) / dv.getUint32(o + 28);
      return dv.getUint32(o + 24) / dv.getUint32(o + 20);
    }
    o += size;
  }
  return NaN;
}
