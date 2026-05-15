import path from 'node:path';
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    alias: { '~': path.resolve(__dirname, 'src') },
    exclude: ['**/node_modules/**', 'build/**'],
    env: {
      DISCORD_BOT_TOKEN: 'token',
      SERVER_URL: 'http://localhost:3000',
      APP_ENV: 'test',
      APP_ORIGIN: 'localhost',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      OTEL_SERVICE_NAME: 'sideline-bot',
    },
  },
});
