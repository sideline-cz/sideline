#!/usr/bin/env node
/**
 * Asserts every RPC whose contract returns a domain `Schema.Class` has a
 * handler that actually constructs one.
 *
 * `Schema.Class` is **nominal**. Returning a repository row from a handler
 * whose contract declares the domain class type-checks perfectly — the two
 * carry identical fields, so structurally the row satisfies the signature —
 * and then fails at encode:
 *
 *     Expected PendingAcceptanceEntry, got PendingAcceptanceRow({...})
 *
 * Encode only runs when a row exists, so the failure ships and lies dormant
 * until real data arrives. Both times that happened here, it surfaced as a
 * poll loop failing every second in production, long after the release:
 *
 *   RulesQuiz/PendingEvents   dormant until the first team enabled a quiz
 *   Invite/PendingAcceptances dormant 10 days, until a bot release polled it
 *
 * The first was fixed and given a hand-written encode test. That test did not
 * generalise, so the second shipped straight past it. This does generalise.
 *
 * **What it checks:** for each `Rpc.make('X', { success: SomeDomainClass })`,
 * that `new SomeDomainClass(` or a decode of it appears somewhere in the
 * server source. Validated against the commit before the invite fix, where it
 * flags that RPC and nothing else.
 *
 * **What it cannot check:** whether *every* handler for a given class
 * constructs it. If class X is built correctly in one handler and passed
 * through as a row in another, this stays quiet. The per-RPC encode tests in
 * `applications/server/test/rpc/*Encode.test.ts` are the finer net; add one
 * whenever a new outbox-style RPC appears.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOMAIN = join(ROOT, 'packages/domain/src');
const SERVER = join(ROOT, 'applications/server/src');

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
};

/** Every `Schema.Class` the domain package exports. */
const domainClasses = new Set();
for (const file of walk(DOMAIN)) {
  for (const m of readFileSync(file, 'utf8').matchAll(
    /export class (\w+) extends Schema\.Class</g,
  )) {
    domainClasses.add(m[1]);
  }
}

/** `Rpc.make('Name', { ... success: X ... })` → the class X, when X is one. */
const contracts = [];
for (const file of walk(join(DOMAIN, 'rpc'))) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/Rpc\.make\(\s*'([\w/]+)'\s*,\s*\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') depth -= 1;
      i += 1;
    }
    const success = /success:\s*([^,\n]+)/.exec(src.slice(start, i));
    if (!success) continue;
    const raw = success[1].trim().replace(/,$/, '');
    const inner = raw.startsWith('Schema.Array(')
      ? raw.slice('Schema.Array('.length).replace(/\)$/, '').trim()
      : raw;
    if (domainClasses.has(inner)) contracts.push({ rpc: m[1], cls: inner });
  }
}

const serverSource = walk(SERVER)
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

const unconstructed = contracts.filter(({ cls }) => {
  const constructed = new RegExp(String.raw`new\s+(\w+\.)?${cls}\s*\(`).test(serverSource);
  const decoded = new RegExp(String.raw`decode\w*\(\s*(\w+\.)?${cls}\s*\)`).test(serverSource);
  return !constructed && !decoded;
});

if (unconstructed.length > 0) {
  console.error('RPC encoding check FAILED — a contract class is never constructed server-side.\n');
  console.error('`Schema.Class` is nominal: returning a repository row here type-checks and then');
  console.error('fails at encode, but only once a row exists — so it ships silently.\n');
  for (const { rpc, cls } of unconstructed) {
    console.error(`  ${rpc}  declares  ${cls}  — nothing builds one in applications/server/src`);
  }
  console.error('\nMap the rows instead:');
  console.error('  Effect.map(Array.map((row) => new SomeRpcGroup.SomeEntry({ ...row })))');
  console.error('\nReference: applications/server/src/rpc/invite/index.ts');
  process.exit(1);
}

console.log(
  `RPC encoding OK — all ${contracts.length} class-returning RPCs construct their contract class`,
);
