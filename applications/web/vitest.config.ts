import path from 'node:path';
import { defineProject } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

export default defineProject({
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
  test: {
    environment: 'jsdom',
    alias: { '~': path.resolve(__dirname, 'src') },
    setupFiles: [path.resolve(__dirname, 'test/setup.ts')],
  },
});
