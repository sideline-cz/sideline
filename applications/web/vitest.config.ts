import path from 'node:path';
import { defineProject } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

export default defineProject({
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
  test: {
    environment: 'jsdom',
    // Pin the timezone so a local run matches CI. Without this the suite inherits the machine's
    // zone while CI runs UTC, so a test that reads a local `Date` part passes for whoever wrote
    // it, greens in CI, and fails on a colleague's machine — which is exactly how the DST cases
    // in `test/datetime.test.ts` shipped broken (they assume UTC+1; UTC+2 moves the spring-forward
    // gap onto 03:30 and normalizes it to 04:30).
    //
    // An explicit `TZ=Europe/Helsinki pnpm test` still overrides this, deliberately: that sweep is
    // how ambient-TZ dependence gets found, and `check.yml` runs one such leg. Files needing a
    // specific zone pin it themselves (`test/datetime.test.ts`, `test/tz.ts`).
    env: { DEV: '', TZ: process.env.TZ ?? 'UTC' },
    alias: { '~': path.resolve(__dirname, 'src') },
    setupFiles: [path.resolve(__dirname, 'test/setup.ts')],
    clearMocks: true,
  },
});
