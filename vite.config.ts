import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { contentIndex } from './vite/md-meta'
import { devFunctions } from './vite/dev-functions'

// base: './' makes the built asset URLs relative, so the static `dist/`
// works when hosted from ANY path (root, a subfolder, GitHub Pages, etc.).
export default defineConfig({
  plugins: [react(), tailwindcss(), contentIndex(), devFunctions()],
  base: './',
  build: {
    rollupOptions: {
      output: {
        // Split rarely-changing vendors into their own cacheable chunks so the
        // entry stays small and updates invalidate less. (react-markdown +
        // highlight.js already live in the lazy NotePage chunk.)
        // mermaid is deliberately absent: it is dynamic-imported from
        // lib/mermaidRender.ts and code-splits its own per-diagram-type
        // renderers, so naming it here would flatten ~10 lazy chunks (cytoscape,
        // katex, the gantt/mindmap parsers) back into one eager download.
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          motion: ['motion'],
          icons: ['react-icons'],
        },
      },
    },
  },
})
