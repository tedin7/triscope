import { triscopeTelemetryPlugin } from '@triscope/core/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [triscopeTelemetryPlugin()],
  server: { port: 5173, open: false },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        index: 'index.html',
        cube: 'labs/cube.html',
      },
    },
  },
});
