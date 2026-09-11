import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base '/hub/' — this app is served off the same Express server at /hub,
// not the site root, so built asset URLs need that prefix baked in.
export default defineConfig({
  plugins: [react()],
  base: '/hub/',
  build: {
    outDir: 'dist',
  },
});
