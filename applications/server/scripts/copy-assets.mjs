#!/usr/bin/env node
/**
 * `build` step — `tsc` never copies non-`.ts` files (see `applications/server/AGENTS.md`, "PDF
 * Fonts Must Be Vendored"). `src/assets/**` (the vendored Noto Sans TTFs consumed by
 * `services/BankStatementPdf.ts` via a relative `new URL(..., import.meta.url)`) must be
 * mirrored into `build/esm/assets/**` at the same relative path so the built module resolves
 * them identically to `src/`. `scripts/assert-dist.mjs` (the `postbuild` step) fails loudly if
 * this step is skipped or trusts a stale cache.
 */
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcAssets = path.join(rootDir, 'src', 'assets');
const distAssets = path.join(rootDir, 'build', 'esm', 'assets');

async function main() {
  await cp(srcAssets, distAssets, { recursive: true });
  console.log(`copy-assets: ${srcAssets} -> ${distAssets}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
