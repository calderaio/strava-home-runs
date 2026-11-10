import { createReadStream, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Connect, type Plugin } from 'vite';

// Serve the generated (private) runs file at ./data/runs.json in dev and preview only.
// It lives outside public/ so `vite build` never copies GPS data into dist/.
const DATA = fileURLToPath(new URL('./data/runs.json', import.meta.url));

function serveData(): Plugin {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    if (!req.url || !/(^|\/)data\/runs\.json(\?|$)/.test(req.url)) return next();
    if (!existsSync(DATA)) {
      res.statusCode = 404;
      res.end('run `bun run ingest <export folder>` first');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    createReadStream(DATA).pipe(res);
  };
  return {
    name: 'serve-runs-data',
    configureServer: (s) => { s.middlewares.use(handler); },
    configurePreviewServer: (s) => { s.middlewares.use(handler); },
  };
}

export default defineConfig({
  base: './',
  publicDir: false, // nothing under public/ is ever copied into a build
  plugins: [serveData()],
  server: { watch: { ignored: ['**/data/**'] } },
  build: { target: 'es2022', chunkSizeWarningLimit: 3000 },
});
