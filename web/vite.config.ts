import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { pwaPlugin } from './vite-plugin-pwa.ts'
import { routeShellsPlugin } from './vite-plugin-route-shells.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte(), pwaPlugin(), routeShellsPlugin()],
  // Dev-only: forward API + signaling to the local Go server (`go run .` on :8080),
  // so `npm run dev` can exercise login, accounts, ICE and WebRTC signaling.
  // In production nginx does this routing instead (see docs/self-hosting.md).
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
})
