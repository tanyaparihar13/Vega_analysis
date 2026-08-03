import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev proxy target. Defaults to the backend's own default port, so nothing
 * changes unless you ask it to — set VITE_API_TARGET to point the dev client
 * at a backend running somewhere else (a second instance on another port, or
 * a shared dev server).
 */
const apiTarget = process.env.VITE_API_TARGET || 'http://localhost:5000';
const wsTarget = apiTarget.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/ws': { target: wsTarget, ws: true },
    },
  },
});
