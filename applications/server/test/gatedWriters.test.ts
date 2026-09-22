// Task 3 (`.work-plans/discord-full-onboarding.md`) — R10, "the grep turned into a test".
//
// `applications/server/AGENTS.md`'s "RSVP Has Two Write Surfaces" section used to end with
// "Grep `upsertRsvp` before shipping" — an invariant that only a human's grep enforced. This file
// replaces that instruction: it walks `applications/server/src` itself and asserts, for a
// table of writers whose action has a roster-integrity consequence (RSVP, training claim,
// carpool seat), (a) the EXACT number of call sites today and (b) that every file containing one
// of those call sites also contains the literal `requireCompleteProfile` — the shared guard
// helper (`src/utils/requireCompleteProfile.ts`) every gated writer must be tapped behind.
//
// A hard-coded count is the point, not a smell: it fails the moment someone adds a FIFTH writer
// (or moves an existing one to a new file) without also wiring the guard, which is exactly the
// residual risk the plan accepts and asks this file to catch instead of a human grep.
//
// `requireCompleteProfile` does not exist anywhere in `src/` yet (Task 3 is unimplemented), so
// every row's "every file also contains the guard" assertion fails first — the correct initial
// red for this file.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(import.meta.dirname, '../src');

/** Every `.ts` file under `src/`, excluding `repositories/` (per the plan: repository-level
 * business errors are a rejected design here — see the plan's "Where the guard lives" section —
 * so a repository file matching a writer's call-site regex, e.g. `upsertRsvp`'s own definition
 * inside `EventRsvpsRepository.ts`, must not be counted as a caller). */
const listSourceFiles = (dir: string): string[] => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'repositories') continue;
      files.push(...listSourceFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
};

const allSourceFiles = listSourceFiles(SRC_ROOT);

type GatedWriter = {
  readonly callExpression: string;
  readonly expectedSites: number;
  readonly expectedFiles: readonly string[];
};

// Paths are relative to `src/`. Counts match the plan's table
// (`.work-plans/discord-full-onboarding.md`, Task 3 test spec) with ONE correction: the plan
// lists `reserveSeat(` at 1 call site, but `rpc/carpool/index.ts` calls `carpools.reserveSeat(`
// from BOTH `Carpool/ReserveSeat` (gated, in scope) and `Carpool/AssignSeat` (a captain assigning
// a seat to someone else — out of Deliverable A's scope, never gated). The plan's own table for
// `claimTraining(` has the identical hazard in reverse — `unclaimTraining(` contains
// `claimTraining(` as a literal substring — and states 1, which this file's word-boundary-aware
// matcher confirms is correct; `reserveSeat(` has no such false-positive neighbour, so 2 is the
// real, previously-uncorrected count. The per-file `requireCompleteProfile` check below still
// gives Task 3 the file-level granularity the plan intends — it does not need call-site precision
// to catch a fifth (or moved) writer.
const GATED_WRITERS: readonly GatedWriter[] = [
  {
    callExpression: 'upsertRsvp(',
    expectedSites: 2,
    expectedFiles: ['api/event-rsvp.ts', 'rpc/event/index.ts'],
  },
  { callExpression: 'claimTraining(', expectedSites: 1, expectedFiles: ['rpc/event/index.ts'] },
  { callExpression: 'reserveSeat(', expectedSites: 2, expectedFiles: ['rpc/carpool/index.ts'] },
  { callExpression: 'addCar(', expectedSites: 1, expectedFiles: ['rpc/carpool/index.ts'] },
];

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A negative lookbehind for an identifier character is required, not a plain substring search:
// `unclaimTraining(` contains the literal substring `claimTraining(` starting at its third
// character, and a naive `indexOf` scan double-counts it as a `claimTraining(` call site.
const callSiteRegex = (callExpression: string): RegExp =>
  new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(callExpression)}`, 'g');

const countOccurrences = (haystack: string, needle: string): number =>
  haystack.match(callSiteRegex(needle))?.length ?? 0;

const findFilesContaining = (needle: string): string[] =>
  allSourceFiles
    .filter((file) => countOccurrences(fs.readFileSync(file, 'utf8'), needle) > 0)
    .map((file) => path.relative(SRC_ROOT, file).split(path.sep).join('/'))
    .sort();

describe('gatedWriters — the profile-gate invariant, enforced by a test, not a grep', () => {
  for (const writer of GATED_WRITERS) {
    describe(`\`${writer.callExpression}\``, () => {
      it(`has exactly ${writer.expectedSites} call site(s) in src/ (excluding repositories/)`, () => {
        const total = allSourceFiles.reduce(
          (sum, file) =>
            sum + countOccurrences(fs.readFileSync(file, 'utf8'), writer.callExpression),
          0,
        );
        expect(total).toBe(writer.expectedSites);
      });

      it(`is called only from ${JSON.stringify(writer.expectedFiles)} — a moved call site is also caught`, () => {
        const actualFiles = findFilesContaining(writer.callExpression);
        expect(actualFiles).toEqual([...writer.expectedFiles].sort());
      });

      it('every file calling it also contains the `requireCompleteProfile` guard', () => {
        const filesCallingWriter = findFilesContaining(writer.callExpression);
        for (const relativeFile of filesCallingWriter) {
          const contents = fs.readFileSync(path.join(SRC_ROOT, relativeFile), 'utf8');
          expect(
            contents.includes('requireCompleteProfile'),
            `${relativeFile} calls \`${writer.callExpression}\` but never references ` +
              '`requireCompleteProfile` — the profile-completeness gate helper',
          ).toBe(true);
        }
      });
    });
  }
});
