import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

export default defineConfig({
  /*
   * `root` must be set explicitly. Vite is invoked from the repo root (there's
   * only one package.json now), so without this it would look for index.html in
   * the repo root rather than here.
   */
  root: here,

  plugins: [react()],

  resolve: {
    alias: {
      // Mirrors the `paths` entry in tsconfig.base.json. In practice every
      // import of this is type-only and erased by esbuild before resolution
      // ever happens — the alias is here so that a future value export doesn't
      // fail mysteriously.
      '@scrapyard/shared': resolve(repoRoot, 'packages/shared/src/index.d.ts'),
    },
  },

  // postcss.config.js and tailwind.config.js live alongside this file.
  css: { postcss: here },

  server: {
    port: 5173,
    /*
     * Proxy keeps the browser same-origin in dev, so the httpOnly session
     * cookie is sent without any SameSite gymnastics.
     *
     * `/login` and `/login-assets` are proxied because the login page is
     * server-rendered by Nest — the SPA no longer contains one. That keeps dev
     * and production behaving the same from the browser's point of view.
     *
     * The one difference: in production Nest also *gates* this bundle, so an
     * anonymous visitor never receives it. Vite serves it unconditionally, so in
     * dev the client-side redirect in App.tsx is what sends you to /login.
     */
    proxy: {
      '/api': { target: process.env.API_ORIGIN || 'http://localhost:3000', changeOrigin: true },
      '/login': { target: process.env.API_ORIGIN || 'http://localhost:3000', changeOrigin: true },
      '/login-assets': {
        target: process.env.API_ORIGIN || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
