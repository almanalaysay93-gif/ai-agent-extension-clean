import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

// @crxjs/vite-plugin currently supports Vite 5 only.
// See: https://github.com/crxjs/chrome-extension-tools/issues/1010
process.env.VITE_EXT = 'true';

export default defineConfig({
  plugins: [
    react(),
    // @ts-expect-error: crxjs plugin accepts manifest via crx(manifest) in v2 beta
    crx({ manifest: manifest as never }),
  ],
  build: {
    // Extension pages can't satisfy crossorigin CORS checks in some
    // Chromium builds (headless in particular), so omit the attribute.
    crossorigin: false,
    rollupOptions: {
      input: {
        sidepanel: 'sidepanel/index.html',
        options: 'options/index.html',
        offscreen: 'offscreen/index.html',
        permission: 'permission/index.html',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5174,
    },
  },
});
