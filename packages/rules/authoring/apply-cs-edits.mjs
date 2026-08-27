#!/usr/bin/env node
/**
 * Applies Czech content edits from a JSON batch, refusing to touch anything
 * normative unless explicitly forced.
 *
 * `node packages/rules/authoring/apply-cs-edits.mjs edits.json [--allow-normative]`
 *
 * **The guard is the point.** `why`, `explain` and `note` state rulings, each
 * cited to a rulebook sub-number. Improving their Czech and shifting their
 * meaning teaches a wrong rule, fluently — which is the exact failure the
 * Czech review gate was originally raised against. Descriptive fields
 * (`title`, `situation`, `question`, `role`, `topic`, option text, fx bubbles)
 * carry no ruling, so their worst case is clumsy phrasing.
 *
 * So descriptive edits apply freely; normative ones abort the whole batch
 * unless `--allow-normative` is passed, which is meant to happen only after a
 * human has read the proposed diff.
 *
 * Each edit is `{ id, path, find, repl }` — a substring replacement rather
 * than a whole-field overwrite, so a batch written against stale content fails
 * loudly (`find` not present) instead of silently clobbering a newer edit.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '../src/content/packages');
const BIOME = join(HERE, '../../../node_modules/.bin/biome');

/** Terminal path segments that state a ruling. */
const NORMATIVE = new Set(['why', 'explain', 'note']);

const isNormative = (path) => path.some((seg) => NORMATIVE.has(seg));

const [batchFile, ...flags] = process.argv.slice(2);
if (!batchFile) {
  console.error('usage: apply-cs-edits.mjs <edits.json> [--allow-normative]');
  process.exit(1);
}
const allowNormative = flags.includes('--allow-normative');
const edits = JSON.parse(readFileSync(batchFile, 'utf8'));

const blocked = edits.filter((e) => isNormative(e.path));
if (blocked.length > 0 && !allowNormative) {
  console.error(`Refusing: ${blocked.length} edit(s) touch normative fields.\n`);
  for (const e of blocked) console.error(`  ${e.id} ${e.path.join('.')}`);
  console.error(
    '\nThese state rulings cited to rulebook sub-numbers. Have a human read the\n' +
      'proposed diff, then re-run with --allow-normative.',
  );
  process.exit(1);
}

const at = (root, path) => {
  let node = root;
  for (const key of path) node = node?.[key];
  return node;
};

let applied = 0;
const missed = [];

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
  const full = join(DIR, file);
  const pkg = JSON.parse(readFileSync(full, 'utf8'));
  let touched = false;

  for (const edit of edits) {
    const scenario = pkg.scenarios.find((s) => s.id === edit.id);
    if (!scenario) continue;
    const node = at(scenario, edit.path);
    if (!node || typeof node.cs !== 'string') {
      missed.push(`${edit.id} ${edit.path.join('.')} — no such field`);
      continue;
    }
    if (!node.cs.includes(edit.find)) {
      missed.push(`${edit.id} ${edit.path.join('.')} — "find" not present (stale batch?)`);
      continue;
    }
    node.cs = node.cs.replace(edit.find, edit.repl);
    console.log(`${edit.id} ${edit.path.join('.')}`);
    console.log(`  - ${edit.find}`);
    console.log(`  + ${edit.repl}`);
    touched = true;
    applied++;
  }

  if (touched) {
    writeFileSync(full, `${JSON.stringify(pkg, null, 2)}\n`);
    execFileSync(BIOME, ['check', '--write', full], { stdio: 'ignore' });
  }
}

console.log(`\napplied ${applied} of ${edits.length}`);
if (missed.length > 0) {
  console.error(`\n${missed.length} NOT applied:`);
  for (const m of missed) console.error(`  ${m}`);
  process.exit(1);
}
