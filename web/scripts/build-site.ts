/**
 * bun run build:site — a self-contained static folder for hosting the page (web/site/, gitignored):
 *
 *   site/index.html, landing.css   landing page: the pre-rendered video first, then "Open the live map"
 *   site/video.mp4, poster.jpg     9:16 H.264 export of the first home, rendered here in headless Chrome
 *   site/robots.txt                disallows everything
 *   site/map/                      the interactive page (vite build --mode site)
 *   site/map/data/runs.json(.gz/.br)  YOUR FULL RUN DATA (every home, exact starts): host it only
 *                                  behind authentication
 *
 * Options:
 *   --reuse-video        keep the existing site/video.mp4 and poster.jpg instead of rendering again
 *   --size 1080x1920     video size (default 1080x1920)
 *   --bitrate 2500000    video bits per second (default 2.5 Mbit/s, about 11 MB for the default 36 s)
 *   --seconds 30         video seconds until the longest run finishes (the page's "Length", default 30)
 *   --headful            show the Chrome window while rendering (debugging)
 * Env: CHROME=/path/to/chrome
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { brotliCompressSync, constants as zc, gzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { Browser } from './cdp.ts';
import { mp4Layout } from './mp4.ts';

const WEB = resolve(import.meta.dir, '..');
const SITE = join(WEB, 'site');
const DATA = join(WEB, 'data', 'runs.json');
const LANDING = join(WEB, 'landing');

const { values: opt } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    'reuse-video': { type: 'boolean', default: false },
    size: { type: 'string', default: '1080x1920' },
    bitrate: { type: 'string', default: '2500000' },
    seconds: { type: 'string', default: '30' },
    headful: { type: 'boolean', default: false },
  },
});

const die = (msg: string): never => { console.error(`build:site: ${msg}`); process.exit(1); };
const step = (msg: string) => console.log(`\n== ${msg}`);
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

if (!existsSync(DATA)) die(`${DATA} not found; run \`bun run ingest <export folder>\` first`);
const [W, H] = opt.size!.split('x').map(Number);
const BITRATE = Number(opt.bitrate);
const SECONDS = Number(opt.seconds);
if (!(W > 0 && H > 0 && W % 2 === 0 && H % 2 === 0)) die(`bad --size ${opt.size}`);
if (!(BITRATE >= 2e5)) die(`bad --bitrate ${opt.bitrate}`);
if (!(SECONDS >= 5 && SECONDS <= 300)) die(`bad --seconds ${opt.seconds}`);

const VIDEO = join(SITE, 'video.mp4');
const POSTER = join(SITE, 'poster.jpg');
const reuse = opt['reuse-video'];
if (reuse && !(existsSync(VIDEO) && existsSync(POSTER))) die('--reuse-video: site/video.mp4 or site/poster.jpg is missing');

async function run(cmd: string[]) {
  const p = Bun.spawn(cmd, { cwd: WEB, stdout: 'inherit', stderr: 'inherit' });
  if ((await p.exited) !== 0) die(`${cmd.join(' ')} failed`);
}

// ---------------------------------------------------------------- pages
step('clean site/');
mkdirSync(SITE, { recursive: true });
for (const f of readdirSync(SITE)) {
  if (reuse && (f === 'video.mp4' || f === 'poster.jpg')) continue;
  rmSync(join(SITE, f), { recursive: true, force: true });
}

step('typecheck + vite build (mode site) -> site/map/');
await run([join(WEB, 'node_modules/.bin/tsc'), '--noEmit']);
await run([join(WEB, 'node_modules/.bin/vite'), 'build', '--mode', 'site', '--outDir', 'site/map', '--emptyOutDir', '--logLevel', 'warn']);

step('landing page, robots.txt, runs.json');
for (const f of ['index.html', 'landing.css', 'robots.txt']) cpSync(join(LANDING, f), join(SITE, f));
const dataDir = join(SITE, 'map', 'data');
mkdirSync(dataDir, { recursive: true });
const raw = readFileSync(DATA);
writeFileSync(join(dataDir, 'runs.json'), raw);
// precompressed copies, served by Caddy's `file_server { precompressed br gzip }`
writeFileSync(join(dataDir, 'runs.json.gz'), gzipSync(raw, { level: 9 }));
writeFileSync(join(dataDir, 'runs.json.br'), brotliCompressSync(raw, {
  params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_SIZE_HINT]: raw.length },
}));
console.log(`runs.json ${mb(raw.length)} (gzip ${mb(statSync(join(dataDir, 'runs.json.gz')).size)}, `
  + `brotli ${mb(statSync(join(dataDir, 'runs.json.br')).size)})`);

// ---------------------------------------------------------------- video + poster
/** Static server for site/ on localhost only, so the page is rendered exactly as it is hosted (under /map/). */
function serveSite() {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      let file = normalize(join(SITE, path));
      if (!file.startsWith(SITE)) return new Response('forbidden', { status: 403 });
      if (path.endsWith('/')) file = join(file, 'index.html');
      if (!existsSync(file) || statSync(file).isDirectory()) return new Response('not found', { status: 404 });
      return new Response(Bun.file(file), { headers: { 'Cache-Control': 'no-store' } });
    },
  });
}

interface RenderInfo {
  home: string; runs: number; frames: number; size: number; posterSize: number;
  codec: string; method: string; incomplete: number[]; fontFallback: boolean; seconds: number;
}

async function render() {
  step(`render the video in headless Chrome: ${W}x${H}, ${(BITRATE / 1e6).toFixed(2)} Mbit/s`);
  const server = serveSite();
  const browser = await Browser.launch({ headless: !opt.headful, args: ['--window-size=1280,1000'] });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
    await page.goto(`http://127.0.0.1:${server.port}/map/`);
    const setup = await page.eval<{ ok: boolean; why?: string; home?: string; runs?: number }>(`(async () => {
      const h = window.homeRuns;
      await h.ready;
      await Promise.race([h.styleReady, new Promise((_, rej) => setTimeout(() => rej(new Error('basemap style did not load in 60 s')), 60000))]);
      const s = document.getElementById('seconds');
      s.value = '${SECONDS}';
      s.dispatchEvent(new Event('change'));
      const m = h.state.model;
      if (!m) return { ok: false, why: document.getElementById('message').textContent };
      return { ok: true, home: h.state.homeId, runs: m.runs.length };
    })()`);
    if (!setup.ok) throw new Error(`the page has no runs to render: ${setup.why}`);
    console.log(`first home (${setup.home}): ${setup.runs} runs`);
    const poll = setInterval(async () => {
      try { process.stdout.write(`\r${await page.eval<string>("document.getElementById('export-status').textContent")}   `); } catch { /* busy */ }
    }, 3000);
    const t0 = performance.now();
    let info: RenderInfo;
    try {
      info = await page.eval<RenderInfo>(`(async () => {
        const h = window.homeRuns;
        const last = h.state.model.total - 1;
        const res = await h.export({ width: ${W}, height: ${H}, seconds: null, download: false, bitrate: ${BITRATE}, capture: [last] });
        window.__video = res.blob;
        const img = await createImageBitmap(await (await fetch(res.pngs[last])).blob());
        const c = new OffscreenCanvas(img.width, img.height);
        c.getContext('2d').drawImage(img, 0, 0);
        window.__poster = await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
        return { home: h.state.homeId, runs: h.state.model.runs.length, frames: res.frames, size: res.blob.size,
          posterSize: window.__poster.size, codec: res.codec, method: res.method, incomplete: res.incompleteFrames,
          fontFallback: res.fontFallback, seconds: res.frames / 30 };
      })()`);
    } finally {
      clearInterval(poll);
      process.stdout.write('\n');
    }
    console.log(`rendered ${info.frames} frames in ${((performance.now() - t0) / 1000).toFixed(0)} s via ${info.method}, ${info.codec}`);
    if (!info.codec.startsWith('avc1') || info.method !== 'webcodecs') throw new Error(`not an H.264 WebCodecs export (${info.codec}, ${info.method})`);
    if (info.incomplete.length) throw new Error(`${info.incomplete.length} frames have gaps in the basemap; check the network and run again`);
    if (info.fontFallback) throw new Error('the map label fonts failed to load; check the network and run again');
    if (errors.length) console.warn(`page errors during the render:\n  ${errors.join('\n  ')}`);
    writeFileSync(VIDEO, await readBlob(page, '__video', info.size));
    writeFileSync(POSTER, await readBlob(page, '__poster', info.posterSize));
  } finally {
    await browser.close();
    server.stop(true);
  }
}

/** Copy a Blob out of the page in base64 chunks (CDP messages have size limits). */
async function readBlob(page: Awaited<ReturnType<Browser['newPage']>>, name: string, size: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  const CHUNK = 3 << 20;
  for (let o = 0; o < size; o += CHUNK) {
    const b64 = await page.eval<string>(`(async () => {
      const buf = new Uint8Array(await window.${name}.slice(${o}, ${o + CHUNK}).arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    })()`);
    parts.push(Buffer.from(b64, 'base64'));
  }
  const out = Buffer.concat(parts);
  if (out.length !== size) throw new Error(`read ${out.length} of ${size} bytes of ${name}`);
  return out;
}

if (!reuse) {
  try {
    await render();
  } catch (e) {
    die(`rendering the video failed: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------- checks + summary
step('check the video');
const mp4 = mp4Layout(readFileSync(VIDEO));
console.log(`top-level boxes: ${mp4.boxes.join(' ')}`);
if (!mp4.fastStart) die('video.mp4 has its moov box after mdat (no fast start)');
console.log(`video.mp4 ${mb(statSync(VIDEO).size)}, ${mp4.duration.toFixed(2)} s, moov before mdat (fast start); `
  + `poster.jpg ${(statSync(POSTER).size / 1e3).toFixed(0)} kB`);

console.log(`\nsite/ is ready (${SITE}).`);
console.log('It contains your FULL runs.json (every home, exact starts): only host it behind a password, never commit it.');
