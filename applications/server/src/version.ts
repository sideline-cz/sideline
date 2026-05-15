import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readVersion = (): string => {
  let current = new URL('./', import.meta.url);
  for (let i = 0; i < 5; i++) {
    try {
      const pkgPath = fileURLToPath(new URL('./package.json', current));
      const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (parsed.name === '@sideline/server') return parsed.version ?? 'unknown';
    } catch {
      // continue walking
    }
    current = new URL('../', current);
  }
  return 'unknown';
};

export const APP_VERSION: string = readVersion();
