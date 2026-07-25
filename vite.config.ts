import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { contentIndex } from './vite/md-meta'

// base: './' makes the built asset URLs relative, so the static `dist/`
// works when hosted from ANY path (root, a subfolder, GitHub Pages, etc.).
export default defineConfig({
  plugins: [react(), tailwindcss(), contentIndex()],
  base: './',
  build: {
    rollupOptions: {
      output: {
        // Split rarely-changing vendors into their own cacheable chunks so the
        // entry stays small and updates invalidate less. (react-markdown +
        // highlight.js already live in the lazy NotePage chunk.)
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          motion: ['motion'],
          icons: ['react-icons'],
        },
      },
    },
  },
})
