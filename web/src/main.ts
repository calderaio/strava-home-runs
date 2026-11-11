import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { Map as MlMap } from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { TripsLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { HomeCandidate, RunsFile } from './lib/format.ts';
import { decodeRuns, filterRuns, headAt, homeRange, trimAround, type Home, type Run } from './lib/runs.ts';
import { candidateId, customId, loadPrefs, savePrefs, type Prefs } from './lib/prefs.ts';
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
  home: $<HTMLSelectElement>('home'),
  homeName: $<HTMLInputElement>('home-name'),
  pick: $<HTMLButtonElement>('pick'),
  pickCancel: $<HTMLButtonElement>('pick-cancel'),
  forget: $<HTMLButtonElement>('forget'),
  pickStatus: $<HTMLParagraphElement>('pick-status'),
  homeNote: $<HTMLParagraphElement>('home-note'),
  privacyRadius: $<HTMLInputElement>('privacy-radius'),
  privacyVal: $<HTMLSpanElement>('privacy-val'),
  mapStatus: $<HTMLParagraphElement>('map-status'),
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
  candidates: [] as HomeCandidate[],
  approxHomes: false,   // privacy-trimmed file: starts and homes are approximate
  defaultRadius: 200,
  prefs: loadPrefs() as Prefs,
  homeId: '',
  picking: false,
  cursor: null as Home | null,
};

interface HomeEntry { id: string; lat: number; lon: number; label: string; custom: boolean }

/** Candidate homes from the file, then homes picked on the map. */
function homeEntries(): HomeEntry[] {
  const r = state.defaultRadius;
  const cands = state.candidates.map((h, i) => {
    const id = candidateId(h.lat, h.lon);
    const name = state.prefs.names[id] || `Home ${i + 1}`;
    const years = h.first === h.last ? `${h.first}` : `${h.first}–${h.last}`;
    return { id, lat: h.lat, lon: h.lon, custom: false, label: `${name} · ${h.runs} runs · ${years}${h.fromOption ? ' · --home' : ''}` };
  });
  const custom = state.prefs.custom.map((c, i) => {
    const name = state.prefs.names[c.id] || `Picked home ${i + 1}`;
    const rg = homeRange(state.all, c, r);
    const years = rg.count ? (rg.first.slice(0, 4) === rg.last.slice(0, 4) ? rg.first.slice(0, 4) : `${rg.first.slice(0, 4)}–${rg.last.slice(0, 4)}`) : 'no runs';
    return { id: c.id, lat: c.lat, lon: c.lon, custom: true, label: `${name} · ${rg.count} runs · ${years}` };
  });
  return [...cands, ...custom];
}

const currentHome = (): HomeEntry | undefined => homeEntries().find((h) => h.id === state.homeId);

function persist() {
  if (!savePrefs(state.prefs)) el.homeNote.textContent = 'Home names and picks cannot be saved in this browser (storage is blocked); they last until you reload.';
}

// ---------------------------------------------------------------- map

const map = new MlMap({
  container: 'map',
  style: STYLE,
  center: [8.23, 46.8], // all of Switzerland until the runs are loaded; the camera then fits the data
  zoom: 6,
  interactive: true, // only used while picking a home; the handlers are switched off below
  dragRotate: false,
  pitchWithRotate: false,
  touchPitch: false,
  boxZoom: false,
  keyboard: false,
  attributionControl: false,
  // No label fade: with fadeDuration 0 MapLibre also places all labels in full on every frame, so
  // what a frame shows depends only on the camera and the loaded tiles, not on wall-clock time.
  // (Freezing MapLibre's clock with setNow() was tried: the map then never reports idle.)
  fadeDuration: 0,
  pixelRatio: 1,
  canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true },
});
const handlers = [map.dragPan, map.scrollZoom, map.doubleClickZoom, map.touchZoomRotate];
const setMapInteractive = (on: boolean) => { for (const h of handlers) (on ? h.enable() : h.disable()); };
setMapInteractive(false);
const overlay = new MapboxOverlay({ interleaved: true, layers: [] });
map.addControl(overlay);
let beforeId: string | undefined;
// 'style.load' fires once the style itself is parsed; MapLibre's 'load' also waits for the first
// tiles, so a slow or hung tile server would otherwise hold everything up.
let styleLoaded = false;
const mapLoaded = new Promise<void>((resolve) => {
  map.on('style.load', () => {
    styleLoaded = true;
    const symbols = map.getStyle().layers.filter((l) => l.type === 'symbol');
    beforeId = symbols[0]?.id;
    // quieter labels, so the routes stay the main thing
    for (const l of symbols) map.setPaintProperty(l.id, 'text-opacity', 0.6);
    resolve();
  });
});
/** Failed tile requests, counted so the export can flag frames with gaps in the basemap. */
const mapHealth = { tileErrors: 0, lastError: '', fontFallback: false };
// When the label fonts (glyph .pbf files) fail to load, MapLibre draws labels with a local fallback
// font and only logs a warning, so listen for that warning to be able to report it.
const consoleWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('Unable to load glyph range') && !mapHealth.fontFallback) {
    mapHealth.fontFallback = true;
    setMapStatus('The map label fonts failed to load, so labels use a fallback font. Check the network connection.');
  }
  consoleWarn(...args);
};
map.on('error', (e) => {
  const ev = e as unknown as { error?: Error; tile?: unknown; sourceId?: string };
  const msg = ev.error?.message ?? String(e);
  if (ev.tile || ev.sourceId) {
    mapHealth.tileErrors++;
    const c = (ev.tile as TileLike | undefined)?.tileID?.canonical;
    if (c && ev.sourceId) failedTiles.set(`${ev.sourceId}/${c.z}/${c.x}/${c.y}`, { source: ev.sourceId, z: c.z, x: c.x, y: c.y });
    mapHealth.lastError = msg;
    setMapStatus(`${mapHealth.tileErrors} map tile request${mapHealth.tileErrors === 1 ? '' : 's'} failed (${msg}). `
      + 'The basemap has gaps; check the network connection. Exports list the affected frames.');
    return;
  }
  console.warn('map:', msg);
  // before the style has loaded an error means there is no basemap at all: say so instead of a blank page
  if (!styleLoaded) showText(`Could not load the basemap style from CARTO (${msg}). Check the network connection and reload.`, 'style');
});
setTimeout(() => {
  if (!styleLoaded) {
    showText('The basemap style from CARTO is still loading after 15 s. The network may be slow or blocked; '
      + 'the map appears as soon as it arrives.', 'style');
  }
}, 15000);
map.on('style.load', () => {
  hideMessage('style');
  // tiles that take long to arrive: say so (without blocking the page) until the map has settled once
  const slow = setTimeout(() => {
    if (!mapHealth.tileErrors && !mapHealth.fontFallback) setMapStatus('Map tiles are loading slowly from CARTO…');
  }, 20000);
  map.once('idle', () => {
    clearTimeout(slow);
    if (!mapHealth.tileErrors && !mapHealth.fontFallback) setMapStatus('');
  });
});

type TileLike = { state: string; tileID: { canonical: { x: number; y: number; z: number } } };

/** Tiles whose request failed and that have not loaded since. */
const failedTiles = new Map<string, { source: string; z: number; x: number; y: number }>();
map.on('sourcedata', (e) => {
  const ev = e as unknown as { sourceId?: string; tile?: TileLike };
  const c = ev.tile?.tileID?.canonical;
  if (c && ev.sourceId && ev.tile?.state === 'loaded') failedTiles.delete(`${ev.sourceId}/${c.z}/${c.x}/${c.y}`);
});

/** Failed tiles at the zoom the map currently draws that overlap the current view, per source. */
function failedTilesInView(): Map<string, { x: number; y: number; z: number }[]> {
  const out = new Map<string, { x: number; y: number; z: number }[]>();
  if (!failedTiles.size) return out;
  const b = map.getBounds();
  const zIdeal = Math.floor(map.getZoom());
  const lonOfX = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
  const latOfY = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
  for (const t of failedTiles.values()) {
    // the source's max zoom caps the ideal zoom, so also accept the deepest tiles below it
    if (t.z > zIdeal || t.z < Math.min(zIdeal, 15) - 1) continue;
    const w = lonOfX(t.x, t.z), e = lonOfX(t.x + 1, t.z), n = latOfY(t.y, t.z), s = latOfY(t.y + 1, t.z);
    if (e < b.getWest() || w > b.getEast() || n < b.getSouth() || s > b.getNorth()) continue;
    const list = out.get(t.source) ?? [];
    list.push({ x: t.x, y: t.y, z: t.z });
    out.set(t.source, list);
  }
  return out;
}
/** Tiles in view whose request failed, per source (reads MapLibre's tile managers; empty if that changes). */
function erroredTiles(): Map<string, { x: number; y: number; z: number }[]> {
  const out = new Map<string, { x: number; y: number; z: number }[]>();
  const tms = (map as unknown as { style?: { tileManagers?: Record<string, { _inViewTiles?: { getAllTiles(): TileLike[] } }> } })
    .style?.tileManagers ?? {};
  for (const [id, tm] of Object.entries(tms)) {
    const bad = (tm._inViewTiles?.getAllTiles() ?? []).filter((t) => t.state === 'errored');
    if (bad.length) out.set(id, bad.map((t) => ({ ...t.tileID.canonical })));
  }
  return out;
}

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
map.on('style.load', () => syncDeckPixelRatio());

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

/** Wait for the map to settle, retrying for up to ~70 s. False if it never went idle. */
/** Successive waits (ms) for the map to settle during an export. */
const MAP_WAITS = [10000, 15000, 20000, 25000];
async function waitForMap(signal?: AbortSignal): Promise<boolean> {
  for (const timeout of MAP_WAITS) {
    if (signal?.aborted) return false;
    if (await mapIdleOnce(timeout, signal)) return true;
  }
  return false;
}

/**
 * Wait until the current frame's basemap is complete. A failed tile request also lets MapLibre go
 * idle, so 'idle' alone is not enough: failed requests during the wait and errored tiles in view
 * count as gaps. Failed tiles are requested once more; returns false if the frame still has gaps.
 */
async function completeMapFrame(signal?: AbortSignal): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const errorsBefore = mapHealth.tileErrors;
    const idle = await waitForMap(signal);
    if (signal?.aborted) return false;
    const errored = erroredTiles();
    for (const [id, tiles] of failedTilesInView()) errored.set(id, [...(errored.get(id) ?? []), ...tiles]);
    if (idle && mapHealth.tileErrors === errorsBefore && !errored.size) return true;
    if (attempt === 0) for (const [id, tiles] of errored) map.refreshTiles(id, tiles);
  }
  return false;
}

// ---------------------------------------------------------------- model

function autoStrength(n: number) {
  return Math.round(Math.min(0.5, Math.max(0.05, 2.4 / Math.sqrt(Math.max(n, 1)))) * 100) / 100;
}

function rebuild() {
  if (state.exporting) return; // the export renders from a frozen model
  const home = currentHome();
  if (!home) return;
  const privacy = Number(el.privacyRadius.value);
  const starting = filterRuns(state.all, { from: el.from.value || '0000', to: el.to.value || '9999', maxStart: Number(el.radius.value), home });
  // page-side privacy: trim the ends near the chosen home before anything is drawn
  const runs = starting.map((r) => trimAround(r, home, privacy)).filter((r): r is Run => r !== null);
  el.radiusVal.textContent = `${el.radius.value} m`;
  el.privacyVal.textContent = `${privacy} m`;
  el.count.textContent = `${runs.length} of ${state.all.length} runs start within ${el.radius.value} m of this home`
    + (starting.length > runs.length ? ` (${starting.length - runs.length} lie entirely inside the privacy radius)` : '');
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
  const titles = defaultTitles(runs, state.prefs.names[home.id] ?? '');
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
  if (state.picking && !state.exporting) {
    if (state.dirty) renderPicking();
    state.dirty = false;
  } else if (m && !state.exporting) {
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
  incompleteFrames: number[]; // frames with gaps in the basemap (tiles failed or did not load in time)
  fontFallback: boolean;      // label fonts failed to load; labels were drawn with a fallback font
  hashes?: string[];          // SHA-256 of each composited frame (debug / determinism check)
  pngs?: Record<number, string>;
}

/** Inputs that would change the model; locked while an export renders. */
const lockable = () => [el.from, el.to, el.radius, el.seconds, el.title, el.subtitle, el.strength, el.size, el.limit,
  el.home, el.homeName, el.pick, el.forget, el.privacyRadius,
  el.file, el.speed, el.play, el.replay, el.scrub, el.export];

// Read frames back through a separate canvas, so hashing never touches the export canvas itself
// (frequent getImageData would switch that canvas to a CPU backend and change how the HUD renders).
let readback: CanvasRenderingContext2D | null = null;
async function sha256(src: HTMLCanvasElement, W: number, H: number) {
  if (!readback || readback.canvas.width !== W || readback.canvas.height !== H) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    readback = c.getContext('2d', { willReadFrequently: true })!;
  }
  readback.drawImage(src, 0, 0);
  const d = await crypto.subtle.digest('SHA-256', readback.getImageData(0, 0, W, H).data);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

class StallError extends Error {}

/** Limits that stop an export that has stalled, instead of letting it run for hours. */
const STALL = { slowFrameSeconds: 60, slowFramesInARow: 3, sampleFrames: 20, factor: 10, graceSeconds: 120 };

function stallGuard() {
  let slowInARow = 0;
  const sample: number[] = [];
  return {
    check(f: number, frames: number, frameSeconds: number, elapsed: number) {
      slowInARow = frameSeconds > STALL.slowFrameSeconds ? slowInARow + 1 : 0;
      if (slowInARow >= STALL.slowFramesInARow) {
        throw new StallError(`rendering stalled: ${slowInARow} frames in a row took over ${STALL.slowFrameSeconds} s each `
          + `(frame ${f + 1} of ${frames}). The map tiles are probably not loading; check the network and export again.`);
      }
      if (sample.length < STALL.sampleFrames) sample.push(frameSeconds);
      if (sample.length === STALL.sampleFrames) {
        const med = [...sample].sort((a, b) => a - b)[STALL.sampleFrames >> 1];
        const expected = med * frames;
        if (elapsed > STALL.factor * expected + STALL.graceSeconds) {
          throw new StallError(`rendering is far slower than expected: ${Math.round(elapsed)} s for ${f + 1} of ${frames} frames, `
            + `while the first frames suggested about ${Math.round(expected)} s in total. Check the network and export again.`);
        }
      }
    },
  };
}

async function runExport(req: ExportRequest = {}): Promise<ExportOutcome> {
  const m = state.model; // frozen for the whole export: trails, camera and HUD all come from it
  if (!m) throw new Error('no runs loaded');
  if (document.hidden) throw new Error('the tab is hidden; keep it visible to export');
  if (!styleLoaded) throw new Error('the basemap has not loaded yet');
  if (state.picking) stopPicking();
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
  const stall = stallGuard();
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
        const tf = performance.now();
        setFrame(f, false, m, trailColor);
        if (!(await completeMapFrame(ac.signal)) && !ac.signal.aborted) incomplete.push(f);
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
        if (req.hashes) hashes.push(await sha256(ctx.canvas, W, H));
        if (req.capture?.includes(f)) pngs[f] = ctx.canvas.toDataURL('image/png');
        stall.check(f, frames, (performance.now() - tf) / 1000, (performance.now() - t0) / 1000);
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
    if (mapHealth.fontFallback) {
      const warn = document.createElement('strong');
      warn.className = 'warn';
      warn.textContent = ' Finished with problems: the map label fonts failed to load, so the labels in this video use a '
        + 'fallback font. Check the network and export again.';
      el.exportStatus.append(warn);
    }
    if (incomplete.length) {
      const warn = document.createElement('strong');
      warn.className = 'warn';
      const list = incomplete.slice(0, 8).join(', ') + (incomplete.length > 8 ? ', …' : '');
      warn.textContent = ` Finished with problems: ${incomplete.length} of ${res.frames} frames have gaps in the basemap `
        + `because map tiles failed or did not load in time (frames ${list}`
        + `${mapHealth.lastError ? `; last error: ${mapHealth.lastError}` : ''}). Check the network and export again.`;
      el.exportStatus.append(warn);
    }
    if (req.download !== false) a.click();
    return { ...res, incompleteFrames: incomplete, fontFallback: mapHealth.fontFallback, ...(req.hashes ? { hashes } : {}), ...(req.capture ? { pngs } : {}) };
  } catch (e) {
    const err = e as Error;
    el.exportStatus.textContent = hiddenStop
      ? 'Export stopped: the tab was hidden, and browsers pause rendering in background tabs. Keep this tab visible and export again.'
      : err instanceof StallError ? `Export stopped: ${err.message}`
        : err.name === 'AbortError' ? 'Export cancelled.' : `Export failed: ${err.message}`;
    throw hiddenStop ? new Error('export stopped: tab hidden') : e;
  } finally {
    document.removeEventListener('visibilitychange', onVisibility);
    state.exporting = false;
    abort = null;
    applyPixelRatio(livePixelRatio());
    for (const i of locked) i.disabled = false;
    setControlsEnabled(!!state.model);
    el.cancel.hidden = true;
    el.progress.hidden = true;
    state.dirty = true;
  }
}

// ---------------------------------------------------------------- data + UI

let messageKey = '';
function showMessage(html: string, key = 'data') {
  el.message.innerHTML = html;
  el.message.hidden = false;
  messageKey = key;
}
function showText(text: string, key = 'data') {
  el.message.textContent = text;
  el.message.hidden = false;
  messageKey = key;
}
/** Hide the stage message, but only if it is the one shown for `key`. */
function hideMessage(key = 'data') {
  if (messageKey === key) el.message.hidden = true;
}
function setMapStatus(text: string) {
  el.mapStatus.textContent = text;
}

function setControlsEnabled(on: boolean) {
  for (const b of [el.play, el.replay, el.scrub, el.export]) b.disabled = !on || state.exporting;
}

function useData(file: RunsFile) {
  const all = decodeRuns(file);
  if (!all.length) throw new Error('the runs file has no runs');
  if (!Array.isArray(file.meta?.homes) || !file.meta.homes.length) throw new Error('the runs file lists no homes');
  state.all = all;
  state.candidates = file.meta.homes;
  state.approxHomes = !!file.meta.privacyTrimmed;
  state.defaultRadius = Math.max(5, Math.ceil(file.meta.radius / 5) * 5);
  const days = state.all.map((r) => r.day).sort();
  for (const i of [el.from, el.to]) { i.min = days[0]; i.max = days[days.length - 1]; }
  el.radius.max = String(Math.max(2000, state.defaultRadius));
  el.radius.value = String(state.defaultRadius);
  el.privacyRadius.value = String(state.prefs.privacyRadius);
  el.radiusNote.textContent = state.approxHomes
    ? 'Approximate: this file was trimmed around every home at ingest and its homes are rounded to about 1 km, so starts are only roughly where the runs began.'
    : '';
  el.privacy.textContent = state.approxHomes
    ? 'The track ends near every home were trimmed when the file was made, and the homes in it are rounded. With many runs, a home can still be estimated from where the trimmed tracks begin and end.'
    : 'Every run starts at home, so the map and the video show where you live. The data file also lists every place you have run from often, so it shows where you have lived; it stays on this computer. Hiding the ends near home helps less than it seems: with many runs, home can still be found to within about a metre from where the tracks begin and end.';
  el.strength.value = String(autoStrength(state.all.length));
  updateStrength();
  el.load.hidden = true;
  fillHomes();
  const ids = homeEntries().map((h) => h.id);
  selectHome(state.prefs.selected && ids.includes(state.prefs.selected) ? state.prefs.selected : ids[0]);
}

function fillHomes() {
  el.home.replaceChildren(...homeEntries().map((h) => new Option(h.label, h.id)), new Option('Pick on map…', 'pick'));
  el.home.value = state.homeId;
}

/** Switch home: date range, name field and the model follow it. */
function selectHome(id: string) {
  const h = homeEntries().find((e) => e.id === id);
  if (!h) return;
  state.homeId = id;
  state.prefs.selected = id;
  persist();
  el.home.value = id;
  el.homeName.value = state.prefs.names[id] ?? '';
  el.forget.hidden = !h.custom;
  const rg = homeRange(state.all, h, Number(el.radius.value));
  el.from.value = rg.first || el.from.min;
  el.to.value = rg.last || el.to.max;
  el.homeNote.textContent = rg.count ? '' : 'No runs start near this home yet; try a larger radius.';
  state.frame = 0;
  setPlaying(false);
  rebuild();
}

// ---------------------------------------------------------------- picking a home on the map

function startPicking() {
  if (!state.all.length || state.exporting) return;
  state.picking = true;
  setPlaying(false);
  setMapInteractive(true);
  el.pick.hidden = true;
  el.pickCancel.hidden = false;
  el.pickStatus.textContent = 'Click the map where the runs start. Drag to pan, scroll to zoom.';
  clearHud();
  el.stage.classList.add('picking');
  state.dirty = true;
}

function stopPicking() {
  state.picking = false;
  state.cursor = null;
  setMapInteractive(false);
  el.pick.hidden = false;
  el.pickCancel.hidden = true;
  el.pickStatus.textContent = '';
  el.stage.classList.remove('picking');
  el.home.value = state.homeId;
  state.dirty = true;
}

/** All runs, fully drawn, plus a circle of the start radius at the cursor and the known homes. */
function renderPicking() {
  const r = Number(el.radius.value);
  const homes = homeEntries();
  overlay.setProps({
    layers: [
      new TripsLayer<Run, { beforeId?: string }>({
        id: 'trails', data: state.all, beforeId, getPath: (d) => d.lonlat, positionFormat: 'XY', _pathType: 'open',
        getTimestamps: (d) => d.t, getColor: state.trailColor, getWidth: 1.5, widthUnits: 'pixels', widthMinPixels: 1,
        currentTime: 1e9, trailLength: 1e10, fadeTrail: false, parameters: ADDITIVE,
      }),
      new ScatterplotLayer<HomeEntry>({
        id: 'homes', data: homes, getPosition: (h) => [h.lon, h.lat], getRadius: 5, radiusUnits: 'pixels',
        getFillColor: (h) => (h.id === state.homeId ? [255, 255, 255, 255] : [255, 196, 150, 220]),
        parameters: { depthCompare: 'always', depthWriteEnabled: false },
      }),
      new ScatterplotLayer<Home>({
        id: 'cursor', data: state.cursor ? [state.cursor] : [], getPosition: (h) => [h.lon, h.lat], getRadius: r,
        radiusUnits: 'meters', stroked: true, filled: true, getFillColor: [255, 255, 255, 30], getLineColor: [255, 255, 255, 200],
        lineWidthUnits: 'pixels', getLineWidth: 1.5, parameters: { depthCompare: 'always', depthWriteEnabled: false },
      }),
    ],
  });
}

function previewCount(h: Home): string {
  const r = Number(el.radius.value);
  const rg = homeRange(state.all, h, r);
  const years = rg.count ? ` (${rg.first.slice(0, 4)}–${rg.last.slice(0, 4)})` : '';
  return `${rg.count} runs start within ${r} m here${years}${state.approxHomes ? ' — approximate, the file was privacy-trimmed' : ''}. Click to use it.`;
}

map.on('mousemove', (e) => {
  if (!state.picking) return;
  state.cursor = { lat: e.lngLat.lat, lon: e.lngLat.lng };
  el.pickStatus.textContent = previewCount(state.cursor);
  state.dirty = true;
});

map.on('click', (e) => {
  if (!state.picking) return;
  const lat = Math.round(e.lngLat.lat * 1e5) / 1e5;
  const lon = Math.round(e.lngLat.lng * 1e5) / 1e5;
  const id = customId(lat, lon);
  if (!state.prefs.custom.some((c) => c.id === id)) state.prefs.custom.push({ id, lat, lon });
  persist();
  stopPicking();
  fillHomes();
  selectHome(id);
});

/** Load data/runs.json, independently of the basemap, and say exactly what went wrong if it fails. */
async function loadDefault() {
  const fail = (html: string) => {
    el.load.hidden = false;
    showMessage(html);
  };
  let res: Response;
  try {
    res = await fetch('data/runs.json', { cache: 'no-store' });
  } catch (e) {
    fail(`<div>Could not request <code>data/runs.json</code> (${escapeHtml((e as Error).message)}).</div>
      <div>Is the dev server (<code>bun run dev</code>) still running?</div>`);
    return;
  }
  if (res.status === 404) {
    fail(`<div>No <code>data/runs.json</code> found.</div>
      <div>Create it with <code>bun run ingest &lt;path to your Strava export&gt;</code> in <code>web/</code>,
      then reload, or load a runs.json with the file picker.</div>`);
    return;
  }
  if (!res.ok) {
    fail(`<div>Loading <code>data/runs.json</code> failed: HTTP ${res.status}.</div>`);
    return;
  }
  try {
    useData(JSON.parse(await res.text()));
  } catch (e) {
    fail(`<div><code>data/runs.json</code> is not a valid runs file (${escapeHtml((e as Error).message)}).</div>
      <div>Run <code>bun run ingest</code> again to recreate it, or load another file with the file picker.</div>`);
  }
}

const escapeHtml = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

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
el.radius.oninput = () => {
  el.radiusVal.textContent = `${el.radius.value} m`;
  if (state.picking) { if (state.cursor) el.pickStatus.textContent = previewCount(state.cursor); state.dirty = true; return; }
  rebuildSoon();
};
el.privacyRadius.oninput = () => {
  el.privacyVal.textContent = `${el.privacyRadius.value} m`;
  state.prefs.privacyRadius = Number(el.privacyRadius.value);
  persist();
  rebuildSoon();
};
el.home.onchange = () => { if (el.home.value === 'pick') startPicking(); else selectHome(el.home.value); };
el.pick.onclick = startPicking;
el.pickCancel.onclick = stopPicking;
el.homeName.oninput = () => {
  const name = el.homeName.value.trim();
  if (name) state.prefs.names[state.homeId] = name; else delete state.prefs.names[state.homeId];
  persist();
  fillHomes();
  rebuildSoon();
};
el.forget.onclick = () => {
  state.prefs.custom = state.prefs.custom.filter((c) => c.id !== state.homeId);
  delete state.prefs.names[state.homeId];
  persist();
  fillHomes();
  selectHome(homeEntries()[0].id);
};
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
  if (e.code === 'Escape' && state.picking) stopPicking();
  if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) {
    e.preventDefault();
    el.play.click();
  }
});
window.addEventListener('resize', layout);

// automation hook (used by the headless smoke test): window.homeRuns.export({seconds: 3})
declare global {
  interface Window {
    homeRuns: {
      ready: Promise<void>; styleReady: Promise<void>; export: typeof runExport; state: typeof state; map: MlMap;
      limits: { STALL: typeof STALL; MAP_WAITS: number[] };
    };
  }
}
// The runs load in parallel with the basemap: slow or failing map tiles never hold up the data.
const ready = (async () => {
  layout();
  requestAnimationFrame(tick);
  await loadDefault();
})();
mapLoaded.then(() => { state.dirty = true; }); // re-render with the trails under the labels
window.homeRuns = { ready, styleReady: mapLoaded, export: runExport, state, map, limits: { STALL, MAP_WAITS } };
