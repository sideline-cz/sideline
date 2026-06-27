import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { devtools } from '@tanstack/devtools-vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';
import viteTsConfigPaths from 'vite-tsconfig-paths';
import pkg from './package.json' with { type: 'json' };

const config = defineConfig({
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      // vite-tsconfig-paths would redirect @sideline/domain to source files that use ~/
      // which vite can't resolve outside the project root. Override to use the built dist.
      '@sideline/domain': fileURLToPath(
        new URL('../../packages/domain/dist/dist/esm/index.js', import.meta.url),
      ),
    },
  },
  plugins: [
    devtools(),
    nitro({
      plugins: [
        './server/plugins/og-url.ts',
        './server/plugins/sw-cache-headers.ts',
        './server/plugins/otlp-endpoint.ts',
      ],
    }),
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    tanstackStart({
      prerender: {
        enabled: false,
      },
    }),
    viteReact(),
  ],
});

export default config;
