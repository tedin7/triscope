import { defineConfig } from 'vite';
import { triscopeTelemetryPlugin } from '@triscope/core/vite';

export default defineConfig({
  plugins: [triscopeTelemetryPlugin()],
  server: { port: 5173, host: '127.0.0.1' },
  build: { target: 'esnext' },
});
