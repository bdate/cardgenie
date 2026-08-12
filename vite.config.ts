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
      '/api': 'http://localhost:8787',
      '/c': 'http://localhost:8787',
    },
  },
})
