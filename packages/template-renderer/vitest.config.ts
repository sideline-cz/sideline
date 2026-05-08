import path from 'node:path';
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    alias: { '~': path.resolve(__dirname, 'src') },
  },
});
