import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the console runs on Vite and forwards server paths to `pnpm --filter @inx.sh/control-api dev`.
const api = 'http://127.0.0.1:3100';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': api, '/sub': api, '/health': api } }
});
