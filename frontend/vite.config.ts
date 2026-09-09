import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // In development the API is a separate process; in Docker nginx does the same job.
    proxy: { '/api': process.env.API_URL ?? 'http://localhost:3001' },
  },
});
