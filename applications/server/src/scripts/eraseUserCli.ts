#!/usr/bin/env tsx
/**
 * Erase a person, for whoever is handling a GDPR Art. 17 request.
 *
 * In production, inside the running container:
 *
 *   majnet exec sideline sideline-server -c production -- \
 *     node /app/applications/server/build/scripts/eraseUserCli.js --user <uuid>
 *
 * Locally, against whatever database the environment points at:
 *
 *   pnpm --filter @sideline/server erase-user --user <uuid>             # dry run
 *   pnpm --filter @sideline/server erase-user --user <uuid> --confirm   # writes
 *
 * It lives under `src/` rather than a top-level `scripts/` directory for one
 * concrete reason: the Dockerfile's runtime stage copies only `build/esm`,
 * and installs with `--prod`, so a `scripts/*.ts` file would be absent from
 * the image and `tsx` would not be there to run it. Compiled into
 * `build/esm/scripts/` it runs under plain `node`, which is the only thing
 * the runtime image has.
 *
 * A script rather than an endpoint or a button, deliberately:
 *
 * - §6 of the privacy policy says deletion is handled by a person. A script
 *   keeps that sentence true without a policy change.
 * - An authorisation slip on an erasure *endpoint* destroys data rather than
 *   merely leaking it. There is no such endpoint to get wrong.
 * - Making it self-service needs decisions this does not: what the
 *   confirmation flow says, whether there is a grace period, whether a team
 *   admin may trigger it for somebody else.
 *
 * Safe by construction: **dry run is the default**. Writing requires the
 * explicit `--confirm` flag, and the dry run runs the real statements inside
 * a transaction it rolls back, so what it prints is what would happen rather
 * than a guess.
 */
// Type-only: erased at compile time, so it does not defeat the lazy runtime
// imports below.
import type { Effect as EffectNs } from 'effect';

const args = process.argv.slice(2);

const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const userId = flag('user');
const confirm = args.includes('--confirm');

if (userId === undefined) {
  console.error('Usage: erase-user --user <uuid> [--confirm]');
  console.error('');
  console.error('Without --confirm this is a dry run: it runs the real statements');
  console.error('inside a transaction and rolls back, then prints what would change.');
  process.exit(1);
}

/**
 * Imported after the argument check, not at the top. `env.ts` validates the
 * database configuration the moment it loads, so a static import would answer
 * `erase-user` with no arguments by printing an env stack trace instead of
 * the usage line.
 */
const main = async () => {
  const { PgClient } = await import('@effect/sql-pg');
  const { Config, Effect } = await import('effect');
  const { env } = await import('~/env.js');
  const { eraseUser } = await import('~/gdpr/eraseUser.js');

  const Pg = PgClient.layerConfig({
    host: Config.succeed(env.DATABASE_HOST),
    port: Config.succeed(env.DATABASE_PORT),
    database: Config.succeed(env.DATABASE_NAME),
    username: Config.succeed(env.DATABASE_USER),
    password: Config.succeed(env.DATABASE_PASS),
  });

  const program = eraseUser(userId, { dryRun: !confirm }).pipe(
    Effect.tap((report) =>
      Effect.sync(() => {
        console.log('');
        console.log(report.dryRun ? '=== DRY RUN — nothing was written ===' : '=== ERASED ===');
        console.log(`subject: ${report.subjectUserId}`);
        console.log('');

        const touched = report.steps.filter((s) => s.rows > 0);
        if (touched.length === 0) {
          console.log('  (no rows matched — already erased, or no such person)');
        }
        for (const step of touched) {
          console.log(
            `  ${step.action.padEnd(12)} ${step.table.padEnd(30)} ${step.rows} row(s)  ${step.detail}`,
          );
        }

        console.log('');
        console.log(`kept on purpose (${report.kept.length} tables):`);
        for (const kept of report.kept) {
          console.log(`  ${kept.table.padEnd(30)} ${kept.reason}`);
        }

        if (report.dryRun) {
          console.log('');
          console.log('Re-run with --confirm to apply. This cannot be undone.');
        }
      }),
    ),
    Effect.provide(Pg),
  );

  await Effect.runPromise(program as EffectNs.Effect<unknown, never, never>);
};

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('Erasure failed — nothing was written (the transaction rolled back).');
    console.error(error);
    process.exit(1);
  },
);
