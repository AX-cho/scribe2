import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
const local = path => fileURLToPath(new URL(path, import.meta.url));
const alias = [
  { find: '@', replacement: local('./src') },
  { find: './onnx-node.js', replacement: local('./src/browser/empty-node.js') },
  { find: 'sharp', replacement: local('./src/browser/empty-node.js') },
];
export default defineConfig({
  base: './', plugins: [react(), tailwindcss()], publicDir: false,
  resolve: { alias, conditions: ['onnxruntime-web-use-extern-wasm', 'browser'] },
  worker: { format: 'es' },
  build: { outDir: 'browser-dist', emptyOutDir: true, rollupOptions: { input: process.env.SCRIBE_BROWSER_BENCHMARK === '1' ? [local('./browser.html'), local('./browser-benchmark.html')] : local('./browser.html') } },
});
