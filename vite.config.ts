import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The renderer's source lives in `src/renderer/api/`, so a module request such
// as `/api/index.ts` shares the `/api` prefix with the dev API. Source files are
// served by Vite; only real API calls are proxied.
const apiProxy = {
  '/api': {
    target: 'http://127.0.0.1:4890',
    changeOrigin: true,
    ws: true,
    bypass: (req: { url?: string }) =>
      /\.(?:[cm]?[jt]sx?|css|json)(?:\?|$)/.test(req.url ?? '') ? req.url : undefined,
  },
}

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
    proxy: apiProxy,
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: apiProxy,
  },
  build: { outDir: '../../dist-web', emptyOutDir: true },
})
