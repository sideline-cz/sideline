import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));

const distPkg = {
  name: pkg.name,
  version: pkg.version,
  type: pkg.type,
  license: pkg.license,
  description: pkg.description,
  repository: pkg.repository,
  sideEffects: [],
  exports: {
    './messages': {
      types: './messages.d.ts',
      import: './messages.js',
    },
    './runtime': {
      types: './runtime.d.ts',
      import: './runtime.js',
    },
    './registry': {
      types: './registry.d.ts',
      import: './registry.js',
    },
    './raw/en.json': './raw/en.json',
    './raw/cs.json': './raw/cs.json',
  },
};

writeFileSync('dist/package.json', `${JSON.stringify(distPkg, null, 2)}\n`);
console.log('Created dist/package.json');

// Generate registry.js
const registryJs = `/* eslint-disable */
import * as m from './messages.js';
export const messagesByKey = m;
export const messageKeys = Object.keys(m);
`;
writeFileSync('dist/registry.js', registryJs);
console.log('Created dist/registry.js');

// Generate registry.d.ts
const registryDts = `import type * as m from './messages.js';
export type MessageFn = (
  inputs?: Record<string, unknown>,
  options?: { locale?: 'en' | 'cs' }
) => string;
export declare const messagesByKey: Record<string, MessageFn>;
export declare const messageKeys: readonly string[];
export type TranslationKey = keyof typeof m;
`;
writeFileSync('dist/registry.d.ts', registryDts);
console.log('Created dist/registry.d.ts');

// Copy raw JSON files
mkdirSync('dist/raw', { recursive: true });
copyFileSync('messages/en.json', 'dist/raw/en.json');
copyFileSync('messages/cs.json', 'dist/raw/cs.json');
console.log('Copied raw JSON files to dist/raw/');
