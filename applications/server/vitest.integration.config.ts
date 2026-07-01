import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '~': path.resolve(__dirname, 'src') },
  },
  test: {
    include: [
      'test/integration/**/*.test.ts',
      'test/rpc/OnboardingSync.test.ts',
      'test/rpc/SudoSession.test.ts',
    ],
    globalSetup: ['test/integration/globalSetup.ts'],
    setupFiles: ['test/integration/setupFile.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
    fileParallelism: false,
    env: {
      DATABASE_HOST: 'localhost',
      DATABASE_PORT: '5432',
      DATABASE_MAIN: 'test',
      DATABASE_NAME: 'test',
      DATABASE_USER: 'test',
      DATABASE_PASS: 'test',
      DISCORD_CLIENT_ID: 'test-client-id',
      DISCORD_CLIENT_SECRET: 'test-client-secret',
      DISCORD_REDIRECT: 'http://localhost',
      FRONTEND_URL: 'http://localhost:5173',
      SERVER_URL: 'http://localhost',
      APP_ENV: 'test',
      APP_ORIGIN: 'localhost',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      OTEL_SERVICE_NAME: 'sideline-server',
      APP_GLOBAL_ADMIN_DISCORD_IDS: '900000000000000001',
      EMAIL_WEBHOOK_SIGNING_SECRET: 'test-signing-secret',
    },
  },
});
