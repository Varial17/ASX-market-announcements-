import { defineConfig } from 'vite';

// The frontend is built into ./public, which is the Worker's static-assets
// directory (see [assets] in wrangler.toml). `npm run deploy` builds first.
export default defineConfig({
  root: 'frontend',
  build: {
    outDir: '../public',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    // `vite dev` alone has no Worker behind it; use `npm run dev` (wrangler)
    // for the full app. This proxy is here for frontend-only iteration
    // against a separately running `wrangler dev`.
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
