import path from 'node:path';
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    alias: { '~': path.resolve(__dirname, 'src') },
    exclude: [
      'test/integration/**',
      'test/rpc/OnboardingSync.test.ts',
      '**/node_modules/**',
      'build/**',
    ],
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
      EMAIL_WEBHOOK_SIGNING_SECRET: 'test-signing-secret-for-vitest',
    },
  },
});
