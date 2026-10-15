import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export default defineConfig({
  root,
  plugins: [react()],
  resolve: { alias: [
    { find: '@/contexts/UpdateContext', replacement: path.join(root, 'design/pastepanda-source-video/updatePreview.ts') },
    { find: '@', replacement: path.join(root, 'src') },
  ] },
  server: { host: '127.0.0.1', port: 1491, strictPort: true, watch: { ignored: ['**/src-tauri/**', '**/.cache/**', '**/docs/**'] } },
  build: { outDir: '.cache/pastepanda-source-video-preview', emptyOutDir: false,
    rollupOptions: { input: [path.join(root, 'design/pastepanda-source-video-2026-10-11.html'), path.join(root, 'design/pastepanda-source-video/surface.html')] } },
});
