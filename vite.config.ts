import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Standalone Vite config used for the browser live-preview (`npm run dev:web`).
// The renderer is environment-agnostic: when `window.kinetic` (the Electron
// bridge) is absent it talks to the dev API server under /api instead.
export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4890', changeOrigin: true, ws: true },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4890', changeOrigin: true, ws: true },
    },
  },
  build: { outDir: '../../dist-web', emptyOutDir: true },
})
