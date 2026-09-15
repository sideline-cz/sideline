#!/usr/bin/env tsx
/**
 * Driver for the install-base-wide group-role member backfill sweep.
 *
 * `POST /auth/global-admins/group-role-member-backfill` (`src/api/global-admin.ts`)
 * deliberately walks ONE team per call (`TEAMS_PER_INVOCATION` in
 * `src/utils/runGroupRoleBackfillPage.ts`) — see that file for why an
 * all-teams-at-once shape is unsafe. That leaves no way to run the sweep to
 * completion across an install base of hundreds of teams without hand-copying
 * `nextAfter` between requests. This script is that driver: it calls the exact
 * same page logic the HTTP handler calls (`runGroupRoleBackfillPage`) directly
 * against the database, in a loop, until every team has been visited.
 *
 * It talks to the database directly rather than through the HTTP endpoint —
 * same reasoning as `eraseUserCli.ts`: this is a tool for whoever has production
 * DB access already, not a self-service action, and it sidesteps needing to
 * mint/copy a global-admin session's bearer token into a shell script. Nothing
 * about the underlying operation changes: it is the identical
 * `runGroupRoleBackfillPage` call the endpoint makes, one team at a time, and
 * the loop's only addition over hand-copying `nextAfter` is not requiring a
 * human between pages.
 *
 * In production, inside the running container:
 *
 *   majnet exec sideline sideline-server -c production -- \
 *     node /app/applications/server/build/scripts/backfillGroupRoleMembersCli.js
 *
 * Locally, against whatever database the environment points at:
 *
 *   pnpm --filter @sideline/server backfill-group-role-members
 *   pnpm --filter @sideline/server backfill-group-role-members --after <team-uuid>
 *
 * `--after <team-uuid>` resumes a walk that was interrupted (Ctrl+C, deploy,
 * crash) instead of restarting from the beginning. The script logs the
 * `nextAfter` cursor after every page specifically so it can be copied into a
 * resumed run.
 *
 * It lives under `src/` rather than a top-level `scripts/` directory for the
 * same concrete reason as `eraseUserCli.ts`: the Dockerfile's runtime stage
 * copies only `build/esm` and installs with `--prod`, so a `scripts/*.ts` file
 * would be absent from the image and `tsx` would not be there to run it.
 * Compiled into `build/esm/scripts/` it runs under plain `node`.
 */
const args = process.argv.slice(2);

const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const afterArg = flag('after');

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: backfill-group-role-members [--after <team-uuid>]');
  console.log('');
  console.log('Walks the group-role member backfill sweep to completion, one team at a');
  console.log('time. Without --after, starts from the beginning. Prints the resumable');
  console.log('cursor after every page, so an interrupted run can be resumed with');
  console.log('--after <cursor>.');
  process.exit(0);
}

/**
 * Imported after the argument check, not at the top. `env.ts` validates the
 * database configuration the moment it loads, so a static import would answer
 * `--help` with no database configured by printing an env stack trace instead
 * of the usage line — same reasoning as `eraseUserCli.ts`.
 */
const main = async () => {
  const { PgClient } = await import('@effect/sql-pg');
  const { Config, Layer, ManagedRuntime, Option, Schema } = await import('effect');
  const { Team } = await import('@sideline/domain');
  const { env } = await import('~/env.js');
  const { Repositories } = await import('~/AppLive.js');
  const { runGroupRoleBackfillPage } = await import('~/utils/runGroupRoleBackfillPage.js');

  const Pg = PgClient.layerConfig({
    host: Config.succeed(env.DATABASE_HOST),
    port: Config.succeed(env.DATABASE_PORT),
    database: Config.succeed(env.DATABASE_NAME),
    username: Config.succeed(env.DATABASE_USER),
    password: Config.succeed(env.DATABASE_PASS),
  });

  const runtime = ManagedRuntime.make(Repositories.pipe(Layer.provideMerge(Pg)));

  let after =
    afterArg === undefined
      ? Option.none()
      : Option.some(Schema.decodeUnknownSync(Team.TeamId)(afterArg));
  let totalProcessed = 0;

  try {
    // Stack-safe by construction: this is a plain imperative loop over
    // independent, one-page-at-a-time `runGroupRoleBackfillPage` calls run
    // through the same `runtime` (one DB pool, reused across pages) rather
    // than one giant recursive Effect.
    for (;;) {
      const page = await runtime.runPromise(runGroupRoleBackfillPage(after));
      totalProcessed += page.processedCount;
      console.log(
        `page done: processed=${page.processedCount} remaining=${page.remainingCount} ` +
          `remainingTeams=${page.remainingTeams} nextAfter=${Option.getOrElse(page.nextAfter, () => '(none — walk complete)')}`,
      );
      if (Option.isNone(page.nextAfter)) {
        break;
      }
      after = page.nextAfter;
    }
    console.log('');
    console.log(`=== DONE — every team visited, ${totalProcessed} member(s) processed ===`);
  } finally {
    await runtime.dispose();
  }
};

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('Group-role member backfill sweep failed partway through.');
    console.error('Re-run with --after <the last logged nextAfter> to resume.');
    console.error(error);
    process.exit(1);
  },
);
