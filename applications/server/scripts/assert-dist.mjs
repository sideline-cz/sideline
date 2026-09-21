#!/usr/bin/env node
/**
 * `postbuild` — verifies the vendored fonts (D9) actually reached `build/esm/`, rather than
 * assuming `copy-assets.mjs` ran. Two independent build traps this guards against:
 *   1. `tsc` never copies `.ttf` files — only `copy-assets.mjs` does, and a future refactor of
 *      the `build` script could silently drop that step.
 *   2. The production image is `node:25-slim`, which has NO system fonts at all — if
 *      `BankStatementPdf.ts`'s vendored-TTF path is ever wrong, there is no base-14 fallback to
 *      mask it in prod (there IS one in dev, on a machine that happens to have fonts installed,
 *      which is exactly what would let this slip through local testing).
 */
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(scriptDir, '..', 'build', 'esm');

const EXPECTED_FONTS = ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf'];
const MIN_FONT_BYTES = 10_000; // a real TTF is hundreds of KB; catches an empty/truncated copy

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const missing = [];
  const tooSmall = [];
  for (const font of EXPECTED_FONTS) {
    const file = path.join(distDir, 'assets', 'fonts', font);
    if (!(await fileExists(file))) {
      missing.push(path.relative(distDir, file));
      continue;
    }
    const { size } = await stat(file);
    if (size < MIN_FONT_BYTES) tooSmall.push(path.relative(distDir, file));
  }

  if (missing.length > 0 || tooSmall.length > 0) {
    const parts = [];
    if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
    if (tooSmall.length > 0)
      parts.push(`too small (<${String(MIN_FONT_BYTES)} bytes): ${tooSmall.join(', ')}`);
    throw new Error(
      `postbuild: vendored fonts did not reach build/esm/ — ${parts.join('; ')}. ` +
        `Did 'node scripts/copy-assets.mjs' run as part of 'build'?`,
    );
  }

  console.log('postbuild: vendored fonts verified in build/esm/assets/fonts/');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
