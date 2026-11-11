/**
 * Minimal Chrome DevTools Protocol client (no dependencies): launch headless Chrome, open a page,
 * evaluate code in it. Used by build-site.ts to render the video and poster.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function findChrome(): string {
  const p = process.env.CHROME ?? CANDIDATES.find((c) => existsSync(c));
  if (!p) throw new Error('Chrome not found; set CHROME=/path/to/chrome');
  return p;
}

type Handler = (params: any, sessionId?: string) => void;

export class Browser {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  private handlers = new Map<string, Set<Handler>>();
  private constructor(private proc: ReturnType<typeof Bun.spawn>, private profile: string, private keepProfile = false) {}

  /** `profile`: reuse this user-data dir (kept on close) instead of a fresh temporary one. */
  static async launch(opts: { args?: string[]; headless?: boolean; profile?: string } = {}): Promise<Browser> {
    const profile = opts.profile ?? mkdtempSync(join(tmpdir(), 'home-runs-chrome-'));
    const proc = Bun.spawn([
      findChrome(),
      ...(opts.headless === false ? [] : ['--headless=new']),
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--ignore-gpu-blocklist',
      ...(opts.args ?? []),
      'about:blank',
    ], { stdout: 'ignore', stderr: 'pipe' });
    const b = new Browser(proc, profile, !!opts.profile);
    const url = await b.readWsUrl();
    b.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      b.ws.onopen = () => resolve();
      b.ws.onerror = () => reject(new Error('could not connect to Chrome'));
    });
    b.ws.onmessage = (ev) => b.onMessage(String(ev.data));
    return b;
  }

  private async readWsUrl(): Promise<string> {
    const reader = (this.proc.stderr as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        // keep draining stderr so Chrome never blocks on a full pipe
        (async () => { try { while (!(await reader.read()).done); } catch { /* closed */ } })();
        return m[1];
      }
    }
    throw new Error(`Chrome did not start:\n${buf}`);
  }

  private onMessage(raw: string) {
    const msg = JSON.parse(raw);
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    for (const h of this.handlers.get(msg.method) ?? []) h(msg.params, msg.sessionId);
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, h: Handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method)!.add(h);
  }

  async newPage(): Promise<Page> {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    return page;
  }

  async close() {
    try { await this.send('Browser.close'); } catch { /* already gone */ }
    const exited = await Promise.race([this.proc.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
    if (!exited) this.proc.kill('SIGKILL');
    try { this.ws.close(); } catch { /* closed */ }
    if (!this.keepProfile) rmSync(this.profile, { recursive: true, force: true });
  }
}

export class Page {
  constructor(readonly browser: Browser, readonly sessionId: string, readonly targetId: string) {}

  send(method: string, params: object = {}) { return this.browser.send(method, params, this.sessionId); }

  on(method: string, h: (params: any) => void) {
    this.browser.on(method, (p, s) => { if (s === this.sessionId) h(p); });
  }

  /** Navigate and wait for the load event. */
  async goto(url: string, timeout = 60000) {
    const loaded = new Promise<void>((resolve) => this.on('Page.loadEventFired', () => resolve()));
    const r = await this.send('Page.navigate', { url });
    if (r.errorText) throw new Error(`navigate ${url}: ${r.errorText}`);
    await Promise.race([loaded, Bun.sleep(timeout).then(() => { throw new Error(`timeout loading ${url}`); })]);
  }

  /** Evaluate an expression (awaiting promises) and return its JSON value. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description ?? d.text ?? 'evaluation failed');
    }
    return r.result.value as T;
  }

  async screenshot(): Promise<Buffer> {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(data, 'base64');
  }
}
