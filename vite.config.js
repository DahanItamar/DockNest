import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:3000' } },
  build: { outDir: 'dist', rollupOptions: { output: { manualChunks(id) { if (id.includes('node_modules') && /[\\/]react(?:-dom)?[\\/]|[\\/]scheduler[\\/]/.test(id)) return 'react-vendor'; } } } }
});
