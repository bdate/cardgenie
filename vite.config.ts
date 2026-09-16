import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync } from 'node:fs'

// https://vite.dev/config/
export default defineConfig({
  base: '/',
  plugins: [
    react(),
    {
      name: 'copy-spa-fallback',
      closeBundle() {
        copyFileSync('dist/index.html', 'dist/404.html')
      },
    },
  ],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            const origin =
              req.headers.origin ||
              (req.headers.referer ? new URL(String(req.headers.referer)).origin : '')
            if (origin) {
              proxyReq.setHeader('X-Frontend-Origin', origin)
            }
          })
        },
      },
      '/c': 'http://localhost:8787',
    },
  },
})
