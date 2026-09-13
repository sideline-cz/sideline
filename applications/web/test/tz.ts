/**
 * Run `f` with the process timezone pinned to `tz`, then restore whatever was there before.
 *
 * Use this for any test whose assertions depend on a wall-clock offset. Do NOT hand-roll the
 * save/mutate/restore dance, because the obvious version has a trap: restoring by assigning the
 * saved value back fails when nothing was set to begin with. Assigning `undefined` to a
 * `process.env` key stores the STRING `"undefined"`, which is not a valid zone, so the process
 * silently falls back to UTC — permanently, because `process.env` is not reset between test
 * files sharing a worker. The effective timezone of later files then depends on file order. That
 * was one of the two things making the DST cases in `datetime.test.ts` flaky. Deleting the key
 * instead of assigning `undefined` back to it is what avoids that trap.
 *
 * That "nothing was set to begin with" branch (`original === undefined`) is currently
 * UNREACHABLE: `vitest.config.ts` sets `env: { TZ: process.env.TZ ?? 'UTC' }`, so every worker
 * process always has `process.env.TZ` defined (at minimum `'UTC'`) before this helper ever runs.
 * It is kept anyway as cheap insurance against exactly that config pin being loosened or removed
 * later — if that ever happens, this helper must still restore "unset" correctly rather than
 * reintroducing the `"undefined"`-string trap above.
 */
export const withTz = <A>(tz: string, f: () => A): A => {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    return f();
  } finally {
    if (original === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = original;
    }
  }
};
