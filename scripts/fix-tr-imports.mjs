/**
 * Fix broken import insertions from codemod-tr.mjs.
 * Finds pattern: `import {\nimport { tr } from '~/lib/translations.js';\n  ...`
 * and moves the tr import to be a separate line before the multi-line import.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { resolve } from 'node:path';

const WEB_SRC = new URL('../applications/web/src', import.meta.url).pathname;

const TR_IMPORT = "import { tr } from '~/lib/translations.js';";
// Pattern: 'import {\n' followed by the tr import line
const BROKEN_PATTERN = /import \{\n(import \{ tr \} from '~\/lib\/translations\.js';\n)/g;

function fixFile(content) {
  if (!content.includes(TR_IMPORT)) {
    return null;
  }

  // Check if tr import is inside a multi-line import block
  if (!BROKEN_PATTERN.test(content)) {
    return null;
  }

  // Reset lastIndex
  BROKEN_PATTERN.lastIndex = 0;

  // Fix: move the tr import OUT of the multi-line import
  // Replace: `import {\nimport { tr } from '...';\n` with `import { tr } from '...';\nimport {\n`
  const fixed = content.replace(BROKEN_PATTERN, `${TR_IMPORT}\nimport {\n`);

  // Make sure we don't have duplicate tr imports
  const trImportCount = (fixed.match(/import \{ tr \} from '~\/lib\/translations\.js';/g) ?? [])
    .length;
  if (trImportCount > 1) {
    // Remove duplicates, keep only first occurrence
    let firstFound = false;
    return fixed.replace(/import \{ tr \} from '~\/lib\/translations\.js';\n/g, (match) => {
      if (!firstFound) {
        firstFound = true;
        return match;
      }
      return '';
    });
  }

  return fixed;
}

async function main() {
  const files = [];
  for await (const file of glob('**/*.{ts,tsx}', { cwd: WEB_SRC })) {
    files.push(resolve(WEB_SRC, file));
  }

  let fixedCount = 0;
  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const fixed = fixFile(content);
      if (fixed !== null) {
        writeFileSync(filePath, fixed, 'utf-8');
        console.log(`Fixed: ${filePath}`);
        fixedCount++;
      }
    } catch (err) {
      console.error(`Error: ${filePath}`, err);
    }
  }
  console.log(`\nFixed ${fixedCount} files.`);
}

main().catch(console.error);
