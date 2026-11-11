/**
 * Title, clock, "still running" counter and finish-time histogram, ported from homeruns/overlay.py.
 * Layout is in px at 1080 x 1920 and scales with the canvas width.
 */
import type { Run } from './runs.ts';

const WHITE = '#e8e8ee', GREY = '#8a8fa3', HOT = '#ff6e1e', DIM = '#462822', AXIS = '#5a5e6e';
const L = {
  titleSize: 120, titleY: 232, lineH: 120, subSize: 34, subGap: 14, clockSize: 100, clockY: 1392,
  statusY: 1502, creditY: 1640, creditSize: 20, margin: 72,
  hist: { x0: 72, x1: 600, top: 1392, base: 1512, labelSize: 22 },
};
/** The map band (px at 1080 x 1920) the camera frames everything into. */
export const BAND = { top: 461, bottom: 1363, side: 72 };

const FONT_TITLE = '"DIN Condensed", "Barlow Condensed", "Roboto Condensed", "Arial Narrow", sans-serif';
const FONT_TEXT = '"Avenir Next", "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const FONT_CLOCK = '"DIN Alternate", "Roboto Mono", "Helvetica Neue", Arial, sans-serif';
export const CREDIT = '© OpenStreetMap contributors © CARTO';

export interface HudModel {
  title: string;
  subtitle: string;
  durs: Float64Array;        // sorted ascending
  bins: Int32Array;          // per sorted run
  full: Int32Array;          // counts per bin
  fullMax: number;
  binMin: number;
  span: number;              // minutes covered by the axis
  ticks: [number, string][];
}

export function histScale(tmax: number): [number, [number, string][]] {
  const mins = tmax / 60;
  const range = (step: number) => Array.from({ length: Math.floor(mins / step) + 1 }, (_, i) => i * step);
  if (mins <= 75) return [2.5, range(15).map((m) => [m, `${m}m`])];
  if (mins <= 150) {
    return [5, range(30).map((m) => [m, m % 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m / 60}h`])];
  }
  return [5, range(60).map((m) => [m, `${m / 60}h`])];
}

/** Title and subtitle like the Python tool; `place` (the home's name) is appended like --place. */
export function defaultTitles(runs: Run[], place = ''): { title: string; subtitle: string } {
  const years = [...new Set(runs.map((r) => r.year))].sort((a, b) => a - b);
  if (!years.length) return { title: 'HOME RUNS', subtitle: 'no runs' };
  const one = years.length === 1;
  const n = runs.length;
  return {
    title: one ? `HOME RUNS ${years[0]}` : `HOME RUNS since ${years[0]}`,
    subtitle: `${n} run${n === 1 ? '' : 's'} ` + (one ? `in ${years[0]}` : `between ${years[0]} and ${years[years.length - 1]}`)
      + (place.trim() ? `, ${place.trim()}` : ''),
  };
}

export function buildHud(runs: Run[], title: string, subtitle: string): HudModel {
  const durs = Float64Array.from(runs, (r) => r.dur).sort();
  const tmax = durs.length ? durs[durs.length - 1] : 60;
  const [binMin, ticks] = histScale(tmax);
  const nb = Math.max(1, Math.ceil(tmax / 60 / binMin));
  const bins = Int32Array.from(durs, (d) => Math.min(Math.floor(d / 60 / binMin), nb - 1));
  const full = new Int32Array(nb);
  for (const b of bins) full[b]++;
  return { title, subtitle, durs, bins, full, fullMax: Math.max(1, ...full), binMin, span: nb * binMin, ticks };
}

export function formatClock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Number of runs with duration > t (still running). */
export function stillRunning(h: HudModel, t: number): number {
  let lo = 0, hi = h.durs.length; // first index with durs > t
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (h.durs[m] <= t) lo = m + 1; else hi = m;
  }
  return h.durs.length - lo;
}

const scrimCache = new Map<number, HTMLCanvasElement>();

/** 1-px-wide column of black with the darkening of overlay.py's scrim, stretched over the frame. */
function scrim(H: number): HTMLCanvasElement {
  let c = scrimCache.get(H);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = 1; c.height = H;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(1, H);
  const k = H / 1920;
  const subY = (L.titleY + L.lineH + L.subGap) * k;
  const topEnd = subY + 110 * k;
  const botStart = (L.clockY - 90) * k;
  for (let y = 0; y < H; y++) {
    const top = Math.min(Math.max((topEnd - y) / (topEnd * 0.55), 0), 1);
    const bot = Math.min(Math.max((y - botStart) / (260 * k), 0), 1);
    img.data[4 * y + 3] = Math.round(255 * 0.72 * Math.max(top, bot) ** 1.3);
  }
  ctx.putImageData(img, 0, 0);
  scrimCache.set(H, c);
  return c;
}

export interface HudFrame {
  clock: number;     // run clock, s
  started: boolean;  // the clock has started (frame >= intro)
  alpha: number;     // text fade-in
}

/** Draw the HUD over whatever is already on `ctx` (W x H px). */
export function drawHud(ctx: CanvasRenderingContext2D, W: number, H: number, h: HudModel, fr: HudFrame) {
  const k = W / 1080;
  const px = (v: number) => v * k;
  const M = px(L.margin);
  ctx.save();
  ctx.drawImage(scrim(H), 0, 0, W, H);
  ctx.globalAlpha = fr.alpha;
  ctx.textBaseline = 'top';

  // title, shrunk until it fits on one line
  let ts = px(L.titleSize);
  ctx.font = `700 ${ts}px ${FONT_TITLE}`;
  while (ctx.measureText(h.title).width > W - 2 * M && ts > 20) {
    ts -= 4;
    ctx.font = `700 ${ts}px ${FONT_TITLE}`;
  }
  ctx.fillStyle = WHITE;
  ctx.textAlign = 'left';
  ctx.fillText(h.title, M, px(L.titleY));
  ctx.font = `500 ${px(L.subSize)}px ${FONT_TEXT}`;
  ctx.fillStyle = GREY;
  ctx.fillText(h.subtitle, M, px(L.titleY + L.lineH + L.subGap));

  // histogram of finish times
  const t = fr.started ? fr.clock : -1;
  const HB = L.hist;
  const x0 = px(HB.x0), x1 = px(HB.x1), top = px(HB.top), base = px(HB.base);
  const nb = h.full.length;
  const bw = (x1 - x0) / nb;
  const done = new Int32Array(nb);
  for (let i = 0; i < h.durs.length && h.durs[i] <= t; i++) done[h.bins[i]]++;
  for (let i = 0; i < nb; i++) {
    const x = x0 + i * bw;
    if (h.full[i]) { // faint ghost of the whole distribution, filled in as runs get home
      const hh = ((base - top) * h.full[i]) / h.fullMax;
      ctx.globalAlpha = fr.alpha * 0.5;
      ctx.fillStyle = DIM;
      ctx.fillRect(x + 1, base - hh, Math.max(bw - 3, 1), hh);
    }
    if (done[i]) {
      const hh = ((base - top) * done[i]) / h.fullMax;
      ctx.globalAlpha = fr.alpha;
      ctx.fillStyle = HOT;
      ctx.fillRect(x + 1, base - hh, Math.max(bw - 3, 1), hh);
    }
  }
  ctx.globalAlpha = fr.alpha;
  ctx.fillStyle = AXIS;
  ctx.fillRect(x0, base + px(1), x1 - x0, px(2));
  const cx = x0 + (x1 - x0) * Math.min(Math.max(t, 0) / 60 / h.span, 1);
  ctx.fillStyle = WHITE;
  ctx.fillRect(cx - px(1), top - px(8), px(2), base - top + px(10));
  ctx.font = `500 ${px(HB.labelSize)}px ${FONT_TEXT}`;
  ctx.fillStyle = GREY;
  ctx.textAlign = 'center';
  for (const [m, lab] of h.ticks) ctx.fillText(lab, x0 + ((x1 - x0) * m) / h.span, base + px(10));
  ctx.textAlign = 'left';
  ctx.fillText('finish times', x0, base + px(44));

  // credit
  ctx.font = `500 ${px(L.creditSize)}px ${FONT_TEXT}`;
  ctx.fillStyle = AXIS;
  ctx.fillText(CREDIT, M, px(L.creditY));

  // clock and counter
  const running = fr.started ? stillRunning(h, fr.clock) : h.durs.length;
  ctx.textAlign = 'right';
  ctx.font = `700 ${px(L.clockSize)}px ${FONT_CLOCK}`;
  ctx.fillStyle = WHITE;
  ctx.fillText(formatClock(fr.clock), W - M, px(L.clockY));
  ctx.font = `500 ${px(L.subSize)}px ${FONT_TEXT}`;
  ctx.fillStyle = GREY;
  ctx.fillText(running ? `${running} still running` : 'all home', W - M, px(L.statusY));
  ctx.restore();
}
