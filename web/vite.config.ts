import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The importer core lives in ../src and is shared with the CLI.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@core': fileURLToPath(new URL('../src', import.meta.url)) },
  },
  server: { fs: { allow: ['..'] } },
  worker: { format: 'es' },
})
