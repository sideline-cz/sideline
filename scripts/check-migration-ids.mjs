#!/usr/bin/env node
/**
 * Asserts every migration id is unique.
 *
 * Effect's `Migrator` aborts with `MigrationError { kind: 'Duplicates' }` when
 * two files share an id — and because migrations run in the integration
 * suite's `globalSetup`, that abort surfaces as:
 *
 *     No test files found, exiting with code 1
 *
 * which names neither migrations nor the colliding id. That cost a red main
 * and a log dig to identify. This turns it into one line at lint time.
 *
 * It happens easily: ids are hand-picked timestamps, so two branches opened
 * around the same time pick the same next number and only collide once both
 * have merged. Nothing in review catches it — each PR is individually fine.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIRS = ['before', 'after'];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages/migrations/src');

let failed = false;

for (const dir of DIRS) {
  let files;
  try {
    files = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.ts'));
  } catch {
    continue; // an optional phase directory that does not exist
  }

  const byId = new Map();
  for (const file of files) {
    const id = file.split('_')[0];
    if (!/^\d+$/.test(id ?? '')) {
      console.error(`${dir}/${file} — filename must start with a numeric id`);
      failed = true;
      continue;
    }
    byId.set(id, [...(byId.get(id) ?? []), file]);
  }

  for (const [id, group] of byId) {
    if (group.length > 1) {
      console.error(`duplicate migration id ${id} in ${dir}/:`);
      for (const f of group.sort()) console.error(`  ${f}`);
      const next = String(Math.max(...[...byId.keys()].map(Number)) + 100000);
      console.error(`  → renumber all but one; the next free id is ${next}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log('migration ids OK — every id is unique');
