import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4843,
    strictPort: true,
    proxy: {
      '/sites': 'http://127.0.0.1:4840',
      '/heartbeats': 'http://127.0.0.1:4840',
      '/auth': 'http://127.0.0.1:4840',
      '/me': 'http://127.0.0.1:4840',
      '/status': 'http://127.0.0.1:4840',
      '/status-page': 'http://127.0.0.1:4840',
      '/health': 'http://127.0.0.1:4840',
    },
  },
  preview: { port: 4843, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, modulePreload: { polyfill: false } },
});
