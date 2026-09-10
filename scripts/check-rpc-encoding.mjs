#!/usr/bin/env node
/**
 * Asserts every contract returning a domain `Schema.Class` — `Rpc.make` and
 * `HttpApiEndpoint` alike — has a handler that actually constructs one.
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
 * **What it checks:** for each contract with `success: SomeDomainClass`, that
 * `new SomeDomainClass(` or a decode of it appears somewhere in the server
 * source. Validated twice by breaking a real case: against the commit before
 * the invite fix it flags that RPC alone, and removing the explicit
 * `new Auth.DataExport(...)` from the export handler flags `exportMyData`
 * alone.
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

/** The class a `success:` schema resolves to, when it is a domain class. */
const successClass = (src, bodyStart) => {
  let depth = 1;
  let i = bodyStart;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') depth -= 1;
    i += 1;
  }
  const success = /success:\s*([^,\n]+)/.exec(src.slice(bodyStart, i));
  if (!success) return undefined;
  const raw = success[1].trim().replace(/,$/, '');
  const inner = raw.startsWith('Schema.Array(')
    ? raw.slice('Schema.Array('.length).replace(/\)$/, '').trim()
    : raw;
  return domainClasses.has(inner) ? inner : undefined;
};

/**
 * Both contract kinds, because the trap is identical on either.
 *
 * `Rpc.make` was the only one covered at first, and the gap showed up
 * immediately: `Auth.DataExport` on `GET /me/export` sat outside the guard and
 * had to be protected by a hand-written test instead — which is exactly the
 * "a guard that does not generalise is not a guard" failure that let the
 * nominal bug ship twice in the first place.
 */
const contracts = [];

for (const file of walk(join(DOMAIN, 'rpc'))) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/Rpc\.make\(\s*'([\w/]+)'\s*,\s*\{/g)) {
    const cls = successClass(src, m.index + m[0].length);
    if (cls !== undefined) contracts.push({ kind: 'RPC', name: m[1], cls });
  }
}

for (const file of walk(join(DOMAIN, 'api'))) {
  const src = readFileSync(file, 'utf8');
  // `HttpApiEndpoint.get('name', '/path', { … })` — the options object is the
  // first `{` after the endpoint name, so the path argument is skipped.
  for (const m of src.matchAll(
    /HttpApiEndpoint\.(?:get|post|patch|put|del|delete)\(\s*'([\w/]+)'/g,
  )) {
    const brace = src.indexOf('{', m.index + m[0].length);
    if (brace === -1) continue;
    const cls = successClass(src, brace + 1);
    if (cls !== undefined) contracts.push({ kind: 'HTTP', name: m[1], cls });
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
  console.error('Encoding check FAILED — a contract class is never constructed server-side.\n');
  console.error('`Schema.Class` is nominal: returning a plain object or a repository row here');
  console.error('type-checks and then fails at encode — but only once there is data to encode,');
  console.error('so it ships silently and surfaces later against real rows.\n');
  for (const { kind, name, cls } of unconstructed) {
    console.error(
      `  [${kind}] ${name}  declares  ${cls}  — nothing builds one in applications/server/src`,
    );
  }
  console.error('\nConstruct the class the contract names:');
  console.error('  a list  →  Effect.map(Array.map((row) => new SomeGroup.SomeEntry({ ...row })))');
  console.error('  one     →  Effect.map((value) => new SomeApi.SomeResult({ ...value }))');
  console.error('\nReferences: applications/server/src/rpc/invite/index.ts (list),');
  console.error('            applications/server/src/api/auth.ts exportMyData (single).');
  process.exit(1);
}

const rpcs = contracts.filter((c) => c.kind === 'RPC').length;
const http = contracts.length - rpcs;
console.log(
  `Encoding OK — all ${contracts.length} class-returning contracts construct their class ` +
    `(${rpcs} RPC, ${http} HTTP)`,
);
