/**
 * Exercises `scripts/check-discord-timestamp.mjs` against fixture trees, not just the
 * real one — a guard that only ever runs against clean code proves nothing. Modelled
 * on `applications/proxy/test/compute-upstreams.test.ts`, which shells out to the
 * script under test rather than importing it (these `check-*.mjs` scripts run their
 * check as top-level side-effecting code, the same shape as `check-migration-ids.mjs`
 * and `check-rpc-encoding.mjs`).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'check-discord-timestamp.mjs');
const REAL_BOT_SRC = path.resolve(__dirname, '..', 'src');

let fixtureDir: string | undefined;

const fixture = (files: Record<string, string>) => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), 'discord-timestamp-guard-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const full = path.join(fixtureDir, relativePath);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return fixtureDir;
};

/** Runs the guard against `dir` and returns its outcome without throwing, so both the
 *  passing and failing paths can be asserted the same way. */
const run = (dir: string): { status: number; stdout: string; stderr: string } => {
  try {
    const stdout = execFileSync('node', [SCRIPT, dir], { encoding: 'utf-8' });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr };
  }
};

afterEach(() => {
  if (fixtureDir !== undefined) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

describe('check-discord-timestamp', () => {
  it('fails on a bare backtick-template token outside the allow-listed file', () => {
    const dir = fixture({
      'rest/somewhere.ts': 'export const x = (secs: number) => `<t:${secs}:f>`;\n',
    });

    const result = run(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('somewhere.ts');
  });

  it('fails on the string-concatenation evasion (no backtick template at all)', () => {
    const dir = fixture({
      'rest/somewhere.ts': "export const x = (secs: number) => '<t:' + secs + ':f>';\n",
    });

    const result = run(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('somewhere.ts');
  });

  it('fails on the differently-named-helper evasion (toDiscordDateTimestamp)', () => {
    const dir = fixture({
      'rcp/finance/buildPaymentReminderEmbed.ts':
        'export const toDiscordDateTimestamp = (iso: string) => iso;\n',
    });

    const result = run(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('buildPaymentReminderEmbed.ts');
  });

  it('counts two literals on one line as two occurrences, not one', () => {
    const dir = fixture({
      'rest/poll/buildPollEmbed.ts':
        'export const x = (a: number, b: number) => `<t:${a}:R> <t:${b}:f>`;\n',
    });

    const result = run(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('2 occurrences');
  });

  it('passes the real applications/bot/src tree (the consolidation is complete)', () => {
    const result = run(REAL_BOT_SRC);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK');
  });

  it('exempts *.test.ts fixtures that legitimately assert on the token', () => {
    const dir = fixture({
      'rest/somewhere.test.ts': "expect(payload).toContain('<t:');\n",
    });

    const result = run(dir);

    expect(result.status).toBe(0);
  });

  it('does not flag the token when it only appears inside a doc comment', () => {
    const dir = fixture({
      'rest/events/eventWhen.ts':
        '/** Renders `<t:S:D>` for the all-day case. */\nexport const x = 1;\n',
    });

    const result = run(dir);

    expect(result.status).toBe(0);
  });

  it('allows the shared primitive itself to build the token', () => {
    const dir = fixture({
      'rest/discordTimestamp.ts': 'export const f = (s: number) => `<t:${s}:f>`;\n',
    });

    const result = run(dir);

    expect(result.status).toBe(0);
  });
});

// S4 review finding: rule 1 ("one builder of the token") does not catch a call site that
// dutifully imports the shared `toDiscordTimestamp` primitive but still passes it a raw
// (un-anchored) instant with a date-only style — exactly the bug class this whole guard
// exists to prevent, one level removed. Two real sites had this bug and passed the
// original guard; both are reproduced here verbatim from git history (pre-fix
// `8d221b84:applications/bot/src/rest/events/buildEventEmbed.ts` and
// `buildEventListEmbed.ts`) to prove rule 2 would have caught them.
describe('check-discord-timestamp — rule 2 (no raw D/d style outside eventWhen.ts)', () => {
  it("fails on a bare literal 'D' style applied to a raw instant (buildEventEmbed.ts, pre-fix)", () => {
    const dir = fixture({
      'rest/events/buildEventEmbed.ts':
        "export const when = (startAt: number) => toDiscordTimestamp(startAt, 'D');\n",
    });

    const result = run(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('buildEventEmbed.ts');
    expect(result.stderr).toContain('raw instant outside');
  });

  it("fails when the style is a computed ternary that CONTAINS 'D' (buildEventListEmbed.ts, pre-fix)", () => {
    const dir = fixture({
      'rest/events/buildEventListEmbed.ts':
        'export const startTs = (entry: { start_at: number; all_day: boolean }) => ' +
        "toDiscordTimestamp(entry.start_at, entry.all_day ? 'D' : 'f');\n",
    });

    const result = run(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('buildEventListEmbed.ts');
  });

  it('passes when the raw instant is wrapped in discordDateInstant(...) first', () => {
    const dir = fixture({
      'rest/events/handleSomeReminder.ts':
        'export const when = (startDate: string, startAt: number) => ' +
        "toDiscordTimestamp(discordDateInstant(startDate, startAt), 'D');\n",
    });

    const result = run(dir);

    expect(result.status).toBe(0);
  });

  it('exempts eventWhen.ts itself, the one place allowed to build a raw D/d style', () => {
    const dir = fixture({
      'rest/events/eventWhen.ts':
        'export const startInstant = (startDate: string, startAt: number) => ' +
        "toDiscordTimestamp(discordDateInstant(startDate, startAt), 'D');\n" +
        "export const raw = (startAt: number) => toDiscordTimestamp(startAt, 'D');\n",
    });

    const result = run(dir);

    expect(result.status).toBe(0);
  });

  it("does not flag 'd'/'D' used as ordinary code text, only a quoted style literal", () => {
    const dir = fixture({
      'rest/events/somewhere.ts':
        'export const label = (n: number) => `Day ${n}`;\n' +
        "export const when = (dt: number) => toDiscordTimestamp(dt, 'f');\n",
    });

    const result = run(dir);

    expect(result.status).toBe(0);
  });

  it('counts a raw D-style call to a DIFFERENT instant in the same expression as a second occurrence', () => {
    const dir = fixture({
      'rest/events/buildEventEmbed.ts':
        'export const when = (startAt: number, endAt: number) => ' +
        "`${toDiscordTimestamp(startAt, 'D')} — ${toDiscordTimestamp(endAt, 'D')}`;\n",
    });

    const result = run(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('2 occurrences');
  });

  it('passes the real applications/bot/src tree against rule 2 as well', () => {
    const result = run(REAL_BOT_SRC);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no date-only style is rendered off a raw instant');
  });
});
