import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { Map as MlMap } from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { TripsLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { RunsFile } from './lib/format.ts';
import { decodeRuns, filterRuns, headAt, type Run } from './lib/runs.ts';
import { FPS, makeWarp, runTime, totalFrames, type WarpParams } from './lib/timewarp.ts';
import { cameraAt, computeCameraTrack, type CameraTrack, type ViewBox } from './lib/camera.ts';
import { BAND, buildHud, defaultTitles, drawHud, formatClock, type HudFrame, type HudModel } from './lib/hud.ts';
import { exportVideo, type ExportResult } from './lib/video.ts';

const STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const STAGE_W = 540;
const STAGE_H = 960;
/** The map band from the HUD layout, in stage CSS px (the stage is half the 1080 x 1920 layout). */
const VIEW: ViewBox = {
  width: STAGE_W,
  height: STAGE_H,
  pad: { top: BAND.top / 2, bottom: (1920 - BAND.bottom) / 2, left: BAND.side / 2, right: BAND.side / 2 },
};
const TRAIL_RGB = [255, 110, 30];
const ADDITIVE = {
  blend: true,
  blendColorOperation: 'add',
  blendColorSrcFactor: 'src-alpha',
  blendColorDstFactor: 'one',
  blendAlphaOperation: 'add',
  blendAlphaSrcFactor: 'zero',
  blendAlphaDstFactor: 'one',
  depthWriteEnabled: false,
  depthCompare: 'always',
} as const;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  viewer: $<HTMLElement>('viewer'),
  stage: $<HTMLDivElement>('stage'),
  hud: $<HTMLCanvasElement>('hud'),
  message: $<HTMLDivElement>('message'),
  play: $<HTMLButtonElement>('play'),
  replay: $<HTMLButtonElement>('replay'),
  readout: $<HTMLSpanElement>('readout'),
  scrub: $<HTMLInputElement>('scrub'),
  speed: $<HTMLSelectElement>('speed'),
  seconds: $<HTMLInputElement>('seconds'),
  from: $<HTMLInputElement>('from'),
  to: $<HTMLInputElement>('to'),
  radius: $<HTMLInputElement>('radius'),
  radiusVal: $<HTMLSpanElement>('radius-val'),
  radiusNote: $<HTMLParagraphElement>('radius-note'),
  privacy: $<HTMLParagraphElement>('privacy'),
  count: $<HTMLParagraphElement>('count'),
  strength: $<HTMLInputElement>('strength'),
  strengthVal: $<HTMLSpanElement>('strength-val'),
  title: $<HTMLInputElement>('title'),
  subtitle: $<HTMLInputElement>('subtitle'),
  size: $<HTMLSelectElement>('size'),
  limit: $<HTMLInputElement>('limit'),
  export: $<HTMLButtonElement>('export'),
  cancel: $<HTMLButtonElement>('cancel'),
  progress: $<HTMLProgressElement>('progress'),
  exportStatus: $<HTMLParagraphElement>('export-status'),
  load: $<HTMLElement>('load'),
  file: $<HTMLInputElement>('file'),
};

interface Model {
  runs: Run[];
  warp: WarpParams;
  total: number;
  camera: CameraTrack;
  hud: HudModel;
}

const state = {
  all: [] as Run[],
  model: null as Model | null,
  frame: 0,
  playing: false,
  exporting: false,
  dirty: true,
  scale: 1,
  trailColor: [...TRAIL_RGB, 30] as [number, number, number, number],
};

// ---------------------------------------------------------------- map

const map = new MlMap({
  container: 'map',
  style: STYLE,
  center: [8.23, 46.8], // all of Switzerland until the runs are loaded; the camera then fits the data
  zoom: 6,
  interactive: false,
  attributionControl: false,
  // No label fade: with fadeDuration 0 MapLibre also places all labels in full on every frame, so
  // what a frame shows depends only on the camera and the loaded tiles, not on wall-clock time.
  // (Freezing MapLibre's clock with setNow() was tried: the map then never reports idle.)
  fadeDuration: 0,
  pixelRatio: 1,
  canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true },
});
const overlay = new MapboxOverlay({ interleaved: true, layers: [] });
map.addControl(overlay);
let beforeId: string | undefined;
let styleLoaded = false;
const mapLoaded = new Promise<void>((resolve) => {
  map.on('load', () => {
    styleLoaded = true;
    const symbols = map.getStyle().layers.filter((l) => l.type === 'symbol');
    beforeId = symbols[0]?.id;
    // quieter labels, so the routes stay the main thing
    for (const l of symbols) map.setPaintProperty(l.id, 'text-opacity', 0.6);
    resolve();
  });
});
map.on('error', (e) => {
  const msg = e.error?.message ?? String(e);
  console.warn('map:', msg);
  // before the style has loaded an error means there is no basemap at all: say so instead of a blank page
  if (!styleLoaded) showText(`Could not load the basemap style from CARTO (${msg}). Check the network connection and reload.`);
});
setTimeout(() => {
  if (!styleLoaded) showText('The basemap style from CARTO has not loaded after 30 s. Check the network connection and reload.');
}, 30000);

/**
 * In interleaved mode deck.gl keeps the drawing-buffer size it saw when it attached to the map's
 * WebGL context (luma.gl does not auto-resize a canvas it does not own). After map.setPixelRatio()
 * the layers would otherwise render into a corner of the larger buffer, so tell it the new size.
 */
interface SizedContext { setDrawingBufferSize(w: number, h: number): void }
function syncDeckPixelRatio(repaint = true) {
  const deck = (map as unknown as { __deck?: { device?: { getDefaultCanvasContext?(): SizedContext; canvasContext?: SizedContext } } }).__deck;
  const ctx = deck?.device?.getDefaultCanvasContext?.() ?? deck?.device?.canvasContext;
  const c = map.getCanvas();
  ctx?.setDrawingBufferSize(c.width, c.height);
  if (repaint) map.triggerRepaint();
}
map.on('load', () => syncDeckPixelRatio());

function layout() {
  const r = el.viewer.getBoundingClientRect();
  state.scale = Math.max(0.1, Math.min(r.width / STAGE_W, r.height / STAGE_H));
  el.stage.style.transform = `scale(${state.scale})`;
  if (!state.exporting) applyPixelRatio(livePixelRatio());
  state.dirty = true;
}

const livePixelRatio = () => Math.min(2, Math.max(0.5, state.scale * (window.devicePixelRatio || 1)));

function applyPixelRatio(pr: number) {
  map.setPixelRatio(pr);
  syncDeckPixelRatio();
  el.hud.width = Math.round(STAGE_W * pr);
  el.hud.height = Math.round(STAGE_H * pr);
}

/** Resolves true once the map has rendered with everything loaded, false on timeout or abort. */
function mapIdleOnce(timeout: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      map.off('idle', onIdle);
      signal?.removeEventListener('abort', onAbort);
      resolve(ok);
    };
    const onIdle = () => finish(true);
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeout);
    signal?.addEventListener('abort', onAbort);
    map.once('idle', onIdle);
    map.triggerRepaint();
  });
}

/** Wait for a complete map frame, retrying for up to ~70 s. Returns false if tiles were still missing. */
async function waitForMap(signal?: AbortSignal): Promise<boolean> {
  for (const timeout of [10000, 15000, 20000, 25000]) {
    if (signal?.aborted) return false;
    if (await mapIdleOnce(timeout, signal)) return true; // 'idle' = rendered with style and tiles loaded
  }
  return false;
}

// ---------------------------------------------------------------- model

function autoStrength(n: number) {
  return Math.round(Math.min(0.5, Math.max(0.05, 2.4 / Math.sqrt(Math.max(n, 1)))) * 100) / 100;
}

function rebuild() {
  if (state.exporting) return; // the export renders from a frozen model
  const runs = filterRuns(state.all, { from: el.from.value || '0000', to: el.to.value || '9999', maxStart: Number(el.radius.value) });
  el.radiusVal.textContent = `${el.radius.value} m`;
  el.count.textContent = `${runs.length} of ${state.all.length} runs`;
  if (!runs.length) {
    state.model = null;
    overlay.setProps({ layers: [] });
    clearHud();
    showText('No runs match the filter.');
    setControlsEnabled(false);
    return;
  }
  hideMessage();
  setControlsEnabled(true);
  const tmax = Math.max(...runs.map((r) => r.dur));
  const seconds = Math.min(300, Math.max(5, Math.round(Number(el.seconds.value)) || 30));
  el.seconds.value = String(seconds); // show the value actually used
  const warp = makeWarp(tmax, seconds);
  const total = totalFrames(warp);
  const clock = Float64Array.from({ length: total }, (_, f) => runTime(f, warp));
  const titles = defaultTitles(runs);
  el.title.placeholder = titles.title;
  el.subtitle.placeholder = titles.subtitle;
  state.model = {
    runs,
    warp,
    total,
    camera: computeCameraTrack(runs, clock, VIEW),
    hud: buildHud(runs, el.title.value || titles.title, el.subtitle.value || titles.subtitle),
  };
  el.scrub.max = String(total - 1);
  state.frame = Math.min(state.frame, total - 1);
  state.dirty = true;
}

function updateStrength() {
  const a = Number(el.strength.value);
  el.strengthVal.textContent = a.toFixed(2);
  state.trailColor = [...TRAIL_RGB, Math.round(a * 255)] as [number, number, number, number];
  state.dirty = true;
}

// ---------------------------------------------------------------- rendering

const hudFrame = (m: Model, f: number, clock: number): HudFrame => ({ clock, started: f >= m.warp.intro, alpha: Math.min(1, f / 30) });

/** Put the map, deck layers and (optionally) the live HUD into the state of frame `f` of model `m`. */
function setFrame(f: number, live: boolean, m: Model | null = state.model, trailColor = state.trailColor) {
  if (!m) return;
  syncDeckPixelRatio(false);
  const clock = runTime(f, m.warp);
  const cam = cameraAt(m.camera, f);
  map.jumpTo({ center: cam.center, zoom: cam.zoom });
  const heads: [number, number][] = [];
  for (const r of m.runs) {
    const h = headAt(r, clock);
    if (h) heads.push(h);
  }
  overlay.setProps({
    layers: [
      new TripsLayer<Run, { beforeId?: string }>({
        id: 'trails',
        data: m.runs,
        beforeId,
        getPath: (r) => r.lonlat,
        positionFormat: 'XY',
        _pathType: 'open',
        getTimestamps: (r) => r.t,
        getColor: trailColor,
        getWidth: 1.5,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        currentTime: clock,
        trailLength: 1e7,
        fadeTrail: false,
        parameters: ADDITIVE,
      }),
      new ScatterplotLayer<[number, number]>({
        id: 'head-glow',
        data: heads,
        getPosition: (d) => d,
        getRadius: 6,
        radiusUnits: 'pixels',
        getFillColor: [255, 110, 30, 36],
        parameters: ADDITIVE,
      }),
      new ScatterplotLayer<[number, number]>({
        id: 'heads',
        data: heads,
        getPosition: (d) => d,
        getRadius: 2.6,
        radiusUnits: 'pixels',
        getFillColor: [255, 196, 150, 255],
        parameters: { depthCompare: 'always', depthWriteEnabled: false },
      }),
    ],
  });
  if (live) {
    const ctx = el.hud.getContext('2d')!;
    ctx.clearRect(0, 0, el.hud.width, el.hud.height);
    drawHud(ctx, el.hud.width, el.hud.height, m.hud, hudFrame(m, f, clock));
    el.readout.textContent = `${formatClock(f / FPS).slice(2)} / ${formatClock(m.total / FPS).slice(2)}`;
    el.scrub.value = String(Math.round(f));
  }
}

function clearHud() {
  el.hud.getContext('2d')!.clearRect(0, 0, el.hud.width, el.hud.height);
}

let last = performance.now();
function tick(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const m = state.model;
  if (m && !state.exporting) {
    if (state.playing) {
      state.frame += dt * FPS * Number(el.speed.value);
      if (state.frame >= m.total - 1) {
        state.frame = m.total - 1;
        setPlaying(false);
      }
      state.dirty = true;
    }
    if (state.dirty) {
      setFrame(state.frame, true);
      state.dirty = false;
    }
  }
  requestAnimationFrame(tick);
}

function setPlaying(p: boolean) {
  state.playing = p;
  el.play.textContent = p ? 'Pause' : 'Play';
}

// ---------------------------------------------------------------- export

let abort: AbortController | null = null;

export interface ExportRequest {
  width?: number; height?: number; seconds?: number | null; download?: boolean;
  hashes?: boolean;     // debug: SHA-256 of every composited frame
  capture?: number[];   // debug: return PNGs of these frames
}
export interface ExportOutcome extends ExportResult {
  incompleteFrames: number[]; // frames rendered before all map tiles had loaded
  hashes?: string[];          // SHA-256 of each composited frame (debug / determinism check)
  pngs?: Record<number, string>;
}

/** Inputs that would change the model; locked while an export renders. */
const lockable = () => [el.from, el.to, el.radius, el.seconds, el.title, el.subtitle, el.strength, el.size, el.limit,
  el.file, el.speed, el.play, el.replay, el.scrub, el.export];

async function sha256(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const d = await crypto.subtle.digest('SHA-256', ctx.getImageData(0, 0, W, H).data);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function runExport(req: ExportRequest = {}): Promise<ExportOutcome> {
  const m = state.model; // frozen for the whole export: trails, camera and HUD all come from it
  if (!m) throw new Error('no runs loaded');
  if (document.hidden) throw new Error('the tab is hidden; keep it visible to export');
  const trailColor = state.trailColor;
  const [selW, selH] = el.size.value.split('x').map(Number);
  const W = req.width ?? selW;
  const H = req.height ?? selH;
  const limit = req.seconds !== undefined ? req.seconds : Number(el.limit.value) || null;
  const frames = limit ? Math.min(m.total, Math.max(1, Math.round(limit * FPS))) : m.total;
  setPlaying(false);
  state.exporting = true;
  const ac = new AbortController();
  abort = ac;
  let hiddenStop = false;
  const onVisibility = () => {
    if (document.hidden) { hiddenStop = true; ac.abort(); }
  };
  document.addEventListener('visibilitychange', onVisibility);
  const locked = lockable();
  for (const i of locked) i.disabled = true;
  el.cancel.hidden = false;
  el.progress.hidden = false;
  el.progress.value = 0;
  el.exportStatus.textContent = `Rendering ${frames} frames at ${W} × ${H}…`;
  const incomplete: number[] = [];
  const hashes: string[] = [];
  const pngs: Record<number, string> = {};
  const t0 = performance.now();
  try {
    applyPixelRatio(W / STAGE_W);
    await waitForMap(ac.signal);
    const res = await exportVideo({
      width: W,
      height: H,
      fps: FPS,
      frames,
      signal: ac.signal,
      draw: async (f, ctx) => {
        setFrame(f, false, m, trailColor);
        if (!(await waitForMap(ac.signal)) && !ac.signal.aborted) incomplete.push(f);
        // Once everything is loaded, render the frame once more from scratch: MapLibre's label placement
        // can still depend on the order in which tiles arrived, and a fresh full placement on a complete
        // tile set evens that out.
        if (!ac.signal.aborted) {
          map.redraw();
          await mapIdleOnce(5000, ac.signal);
        }
        if (ac.signal.aborted) throw new DOMException('export cancelled', 'AbortError');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(map.getCanvas(), 0, 0, W, H);
        drawHud(ctx, W, H, m.hud, hudFrame(m, f, runTime(f, m.warp)));
        if (req.hashes) hashes.push(await sha256(ctx, W, H));
        if (req.capture?.includes(f)) pngs[f] = ctx.canvas.toDataURL('image/png');
      },
      onProgress: (done, total) => {
        el.progress.value = done / total;
        if (done % 10 === 0 || done === total) {
          const rate = done / ((performance.now() - t0) / 1000);
          el.exportStatus.textContent = `Frame ${done} / ${total} (${rate.toFixed(1)} fps)`
            + (incomplete.length ? ` — ${incomplete.length} frames with missing map tiles so far` : '');
        }
      },
    });
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const url = URL.createObjectURL(res.blob);
    const name = `home-runs-${W}x${H}.${res.ext}`;
    el.exportStatus.textContent = '';
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.textContent = `Download ${name}`;
    const codecNote = res.codec.startsWith('avc1') ? 'H.264'
      : `${res.codec} (not H.264, so some players and sites may not play it)`;
    el.exportStatus.append(a, ` — ${(res.blob.size / 1e6).toFixed(1)} MB, ${res.frames} frames, ${codecNote}, via ${res.method}, ${secs} s.`);
    if (incomplete.length) {
      const warn = document.createElement('strong');
      warn.className = 'warn';
      const list = incomplete.slice(0, 8).join(', ') + (incomplete.length > 8 ? ', …' : '');
      warn.textContent = ` Finished with problems: ${incomplete.length} of ${res.frames} frames were rendered before all map `
        + `tiles had loaded (frames ${list}), so the basemap may have gaps there. Check the network and export again.`;
      el.exportStatus.append(warn);
    }
    if (req.download !== false) a.click();
    return { ...res, incompleteFrames: incomplete, ...(req.hashes ? { hashes } : {}), ...(req.capture ? { pngs } : {}) };
  } catch (e) {
    const err = e as Error;
    el.exportStatus.textContent = hiddenStop
      ? 'Export stopped: the tab was hidden, and browsers pause rendering in background tabs. Keep this tab visible and export again.'
      : err.name === 'AbortError' ? 'Export cancelled.' : `Export failed: ${err.message}`;
    throw hiddenStop ? new Error('export stopped: tab hidden') : e;
  } finally {
    document.removeEventListener('visibilitychange', onVisibility);
    state.exporting = false;
    abort = null;
    applyPixelRatio(livePixelRatio());
    for (const i of locked) i.disabled = false;
    setControlsEnabled(!!state.model);
    el.radius.disabled = state.all.some((r) => r.sd === null);
    el.cancel.hidden = true;
    el.progress.hidden = true;
    state.dirty = true;
  }
}

// ---------------------------------------------------------------- data + UI

function showMessage(html: string) {
  el.message.innerHTML = html;
  el.message.hidden = false;
}
function showText(text: string) {
  el.message.textContent = text;
  el.message.hidden = false;
}
function hideMessage() {
  el.message.hidden = true;
}

function setControlsEnabled(on: boolean) {
  for (const b of [el.play, el.replay, el.scrub, el.export]) b.disabled = !on || state.exporting;
}

function useData(file: RunsFile) {
  state.all = decodeRuns(file);
  if (!state.all.length) throw new Error('the runs file has no runs');
  const days = state.all.map((r) => r.day).sort();
  for (const i of [el.from, el.to]) { i.min = days[0]; i.max = days[days.length - 1]; }
  el.from.value = days[0];
  el.to.value = days[days.length - 1];
  const maxR = Math.max(1, Math.ceil(file.meta.radius));
  el.radius.max = String(maxR);
  el.radius.value = String(maxR);
  const trimmed = file.meta.privacyTrimmed || state.all.some((r) => r.sd === null);
  el.radius.disabled = trimmed; // privacy-trimmed files carry no start distances
  el.radiusNote.textContent = trimmed ? 'Not available: the ends of these tracks were privacy-trimmed.' : '';
  el.privacy.textContent = trimmed
    ? 'The track ends near home were trimmed. With many runs, home can still be estimated from where the trimmed tracks begin and end, to within about a metre.'
    : 'Every run starts at home, so the map and the video show where you live. Ingest with --privacy-radius to trim the ends (this hides less than it seems with many runs).';
  el.strength.value = String(autoStrength(state.all.length));
  updateStrength();
  el.load.hidden = true;
  state.frame = 0;
  rebuild();
}

async function loadDefault() {
  try {
    const res = await fetch('data/runs.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    useData(await res.json());
  } catch (e) {
    console.info('no data/runs.json:', (e as Error).message);
    el.load.hidden = false;
    showMessage(`<div>No <code>data/runs.json</code> found.</div>
      <div>Create it with <code>bun run ingest &lt;path to your Strava export&gt;</code> in <code>web/</code>,
      then reload, or load a runs.json with the file picker.</div>`);
  }
}

let rebuildTimer = 0;
const rebuildSoon = () => { clearTimeout(rebuildTimer); rebuildTimer = window.setTimeout(rebuild, 120); };

el.play.onclick = () => {
  const m = state.model;
  if (!m) return;
  if (!state.playing && state.frame >= m.total - 1) state.frame = 0;
  setPlaying(!state.playing);
};
el.replay.onclick = () => { state.frame = 0; setPlaying(true); state.dirty = true; };
el.scrub.oninput = () => { state.frame = Number(el.scrub.value); state.dirty = true; };
for (const i of [el.from, el.to, el.seconds]) i.onchange = rebuild;
el.radius.oninput = () => { el.radiusVal.textContent = `${el.radius.value} m`; rebuildSoon(); };
el.strength.oninput = updateStrength;
el.title.oninput = el.subtitle.oninput = rebuildSoon;
el.export.onclick = () => { runExport().catch((e) => console.warn('export:', (e as Error).message)); };
el.cancel.onclick = () => abort?.abort();
el.file.onchange = async () => {
  const f = el.file.files?.[0];
  if (!f) return;
  try { useData(JSON.parse(await f.text())); } catch (e) { showText(`Could not read ${f.name}: ${(e as Error).message}`); }
};
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) {
    e.preventDefault();
    el.play.click();
  }
});
window.addEventListener('resize', layout);

// automation hook (used by the headless smoke test): window.homeRuns.export({seconds: 3})
declare global {
  interface Window { homeRuns: { ready: Promise<void>; export: typeof runExport; state: typeof state; map: MlMap } }
}
const ready = (async () => {
  layout();
  await mapLoaded;
  await loadDefault();
  requestAnimationFrame(tick);
})();
window.homeRuns = { ready, export: runExport, state, map };
