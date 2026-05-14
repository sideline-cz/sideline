/**
 * Codemod: Replace `import * as m from '@sideline/i18n/messages'` and `m.key(args)` calls
 * with `import { tr } from '~/lib/translations'` and `tr('key', args)` in web app files.
 *
 * Usage: node scripts/codemod-tr.mjs [--dry-run]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { resolve } from 'node:path';

const isDryRun = process.argv.includes('--dry-run');

const WEB_SRC = new URL('../applications/web/src', import.meta.url).pathname;

// Regex to match import of messages namespace: `import * as m from '@sideline/i18n/messages'`
// Also handles: `import * as m from '@sideline/i18n/messages';`
const _NAMESPACE_IMPORT_RE =
  /^(\s*)import\s+\*\s+as\s+m\s+from\s+'@sideline\/i18n\/messages'(\s*;?\s*)$/gm;

// Also handle the case where messages namespace is combined with other imports
// e.g. `import * as m from '@sideline/i18n/messages'` — this is always a standalone import

// Match m.keyName(args) calls where:
// - keyName is [a-zA-Z_][a-zA-Z0-9_]*
// - args is optional: could be nothing, could be {key: value}, could be complex
// We need to handle nested parens/braces carefully.
// Strategy: find m.keyName( and then match balanced parens.

/**
 * Find and replace all `m.<key>(...)` calls in a string.
 * Returns the transformed string.
 */
function replaceMCalls(source) {
  let result = '';
  let i = 0;

  while (i < source.length) {
    // Look for `m.` followed by an identifier followed by `(`
    if (source[i] === 'm' && source[i + 1] === '.' && i > 0) {
      // Check the character before 'm' — it should NOT be a word char (to avoid matching `pm.foo`)
      const prevChar = source[i - 1];
      const isWordChar = /\w/.test(prevChar);
      if (isWordChar) {
        result += source[i];
        i++;
        continue;
      }
    }

    if (source.startsWith('m.', i)) {
      // Check preceding char is not a word char
      const prevChar = i > 0 ? source[i - 1] : ' ';
      if (/\w/.test(prevChar)) {
        result += source[i];
        i++;
        continue;
      }

      // Try to match identifier after m.
      let j = i + 2;
      while (j < source.length && /[\w]/.test(source[j])) {
        j++;
      }

      if (j === i + 2) {
        // No identifier after m.
        result += source[i];
        i++;
        continue;
      }

      const keyName = source.slice(i + 2, j);

      // Skip if it doesn't look like a translation key (translation keys use snake_case or camelCase)
      // and must be followed by (
      if (source[j] !== '(') {
        result += source[i];
        i++;
        continue;
      }

      // Now match the balanced parens from j
      const argsStart = j; // points to '('
      let depth = 0;
      let k = j;
      while (k < source.length) {
        if (source[k] === '(') depth++;
        else if (source[k] === ')') {
          depth--;
          if (depth === 0) {
            k++;
            break;
          }
        }
        k++;
      }

      const _fullCall = source.slice(i, k); // m.keyName(...)
      const innerArgs = source.slice(argsStart + 1, k - 1).trim(); // content inside parens

      let replacement;
      if (!innerArgs) {
        replacement = `tr('${keyName}')`;
      } else {
        replacement = `tr('${keyName}', ${innerArgs})`;
      }

      result += replacement;
      i = k;
      continue;
    }

    result += source[i];
    i++;
  }

  return result;
}

/**
 * Transform a single file's content.
 * Returns null if no changes needed.
 */
function transformFile(content, _filePath) {
  let changed = false;

  // Check if file has the namespace import
  const hasNamespaceImport = /import\s+\*\s+as\s+m\s+from\s+'@sideline\/i18n\/messages'/.test(
    content,
  );
  if (!hasNamespaceImport) {
    return null;
  }

  let transformed = content;

  // Replace m.key() calls first
  const afterCalls = replaceMCalls(transformed);
  if (afterCalls !== transformed) {
    changed = true;
    transformed = afterCalls;
  }

  // Now handle the import replacement
  // We need to:
  // 1. Remove the `import * as m from '@sideline/i18n/messages'` line
  // 2. Add `import { tr } from '~/lib/translations'` if not already present

  const hasTrImport = /import\s+\{[^}]*\btr\b[^}]*\}\s+from\s+'~\/lib\/translations'/.test(
    transformed,
  );

  // Remove the namespace import line
  transformed = transformed.replace(
    /^(\s*)import\s+\*\s+as\s+m\s+from\s+'@sideline\/i18n\/messages'(\s*;?\s*\n?)/gm,
    '',
  );
  changed = true;

  if (!hasTrImport) {
    // Add tr import. Insert after the last import statement.
    // Simple approach: find the first non-import line and insert before it.
    // Or just prepend at top after last existing import.

    // Find position after last import statement
    const importEndRegex = /^import\s+.+$/gm;
    let lastImportEnd = 0;
    for (const match of transformed.matchAll(importEndRegex)) {
      lastImportEnd = match.index + match[0].length;
    }

    if (lastImportEnd > 0) {
      transformed =
        transformed.slice(0, lastImportEnd) +
        "\nimport { tr } from '~/lib/translations.js';" +
        transformed.slice(lastImportEnd);
    } else {
      transformed = `import { tr } from '~/lib/translations.js';\n${transformed}`;
    }
  }

  // Clean up any double blank lines that might have been created
  transformed = transformed.replace(/\n{3,}/g, '\n\n');

  return changed ? transformed : null;
}

async function main() {
  const files = [];

  // Use glob to find all .ts and .tsx files in web/src
  for await (const file of glob('**/*.{ts,tsx}', { cwd: WEB_SRC })) {
    files.push(resolve(WEB_SRC, file));
  }

  let modifiedCount = 0;
  let errorCount = 0;

  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const transformed = transformFile(content, filePath);

      if (transformed !== null) {
        modifiedCount++;
        if (isDryRun) {
          console.log(`[dry-run] Would modify: ${filePath}`);
        } else {
          writeFileSync(filePath, transformed, 'utf-8');
          console.log(`Modified: ${filePath}`);
        }
      }
    } catch (err) {
      errorCount++;
      console.error(`Error processing ${filePath}:`, err);
    }
  }

  console.log(`\nDone. Modified: ${modifiedCount} files. Errors: ${errorCount}.`);
}

main().catch(console.error);
