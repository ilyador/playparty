import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5176,
    proxy: { '/api': 'http://127.0.0.1:5175', '/events': { target: 'ws://127.0.0.1:5175', ws: true } },
  },
  build: { sourcemap: false },
});
