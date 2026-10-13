import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// one project, two sites: the playground (glc.1lop.ru, ../site) and the converter (gcast.1lop.ru, the gcast-converter repo)
export default defineConfig(({ mode }) => {
  const converter = mode === 'converter';
  return {
    plugins: [react()],
    publicDir: converter ? 'public-converter' : 'public-site',
    build: {
      outDir: converter ? '../../gcast-converter/docs' : '../site',
      emptyOutDir: true,
      rollupOptions: { input: converter ? 'converter.html' : 'index.html' },
    },
    worker: { format: 'es' },
  };
});
