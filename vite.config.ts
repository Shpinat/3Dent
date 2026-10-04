import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      events: resolve(projectRoot, 'node_modules/events/events.js'),
      url: resolve(projectRoot, 'node_modules/url/url.js'),
    },
  },
  optimizeDeps: {
    exclude: ['@cornerstonejs/core', '@cornerstonejs/tools', '@cornerstonejs/dicom-image-loader'],
    include: [
      'fast-deep-equal',
      'seedrandom',
      'spark-md5',
      'xmlbuilder2',
      'lodash.get',
      '@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasmjs',
      '@cornerstonejs/codec-openjpeg/decodewasmjs',
      '@cornerstonejs/codec-openjph/wasmjs',
      '@cornerstonejs/codec-charls/decodewasmjs',
      '@cornerstonejs/codec-libjxl/decodewasmjs',
    ],
  },
  worker: {
    format: 'es',
  },
});
