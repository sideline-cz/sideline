/**
 * Reads the precomputed rules clips that the `gifs` stage of
 * `applications/bot/Dockerfile` bakes into the image — 109 scenarios × two
 * clips, rendered from the same `RulesFieldSvg` component the web trainer
 * uses so the two surfaces cannot drift.
 *
 * **Which clip goes where is a spoiler rule, not a preference.** The `setup`
 * clip covers `[0, qAt]` and belongs on the public question message; the
 * `resolution` clip covers `[0, dur]` and may only ever reach a participant
 * who has finished their own chain. Posting a resolution to the channel
 * spoils the scenario for everyone still working through it, which is the
 * single easiest thing to get wrong here because it is also the more obvious
 * implementation (`docs/plans/rules-trainer.md`).
 *
 * The gate is stronger than the web one: frames past `qAt` are not in the
 * setup file at all, so nobody can scrub past what was never encoded.
 *
 * **Absent clips are an ordinary outcome, never a failure.** `RULES_GIF_DIR`
 * is unset in dev and in tests, and a quiz that posts without an animation is
 * still completely answerable. So every function here returns `undefined`
 * rather than failing, and callers fall back to a text-only message.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ClipKind = 'setup' | 'resolution';

/**
 * Read per call, not captured at module load. Binding it to a `const` at
 * import time froze whatever the environment happened to be when this module
 * was first pulled in, which made the directory impossible to vary — the
 * spoiler-gate tests below could not point it anywhere.
 *
 * Set by the Dockerfile; absent in dev, tests, and any non-container run.
 */
const clipDir = (): string | undefined => process.env.RULES_GIF_DIR;

/**
 * Deliberately not cached. The whole set is ~67 MiB, so caching on demand
 * would let a busy guild pull all of it resident to save a sub-millisecond
 * read of one ~300 KiB file. Clip reads happen once per quiz post and once
 * per completed chain — nowhere near hot enough to trade memory for.
 */
export const readClip = (scenarioId: string, kind: ClipKind): Uint8Array | undefined => {
  const dir = clipDir();
  if (dir === undefined) return undefined;
  try {
    return readFileSync(join(dir, `${scenarioId}-${kind}.gif`));
  } catch {
    // A missing or unreadable file means this scenario renders without its
    // animation. Failing the interaction instead would turn a cosmetic gap
    // into a dead button.
    return undefined;
  }
};

/**
 * A clip as the pieces a Discord message needs: the `File` for
 * `rest.withFiles`, and the `attachment://` URL an embed's `image.url` must
 * point at to render it inline rather than as a bare download.
 */
export const clipAttachment = (
  scenarioId: string,
  kind: ClipKind,
): { file: File; url: string } | undefined => {
  const bytes = readClip(scenarioId, kind);
  if (bytes === undefined) return undefined;
  const filename = `${scenarioId}-${kind}.gif`;
  return {
    file: new File([bytes as BlobPart], filename, { type: 'image/gif' }),
    url: `attachment://${filename}`,
  };
};

/**
 * The `files` entry of an `Ix.response`, present only when there is something
 * to send.
 *
 * dfx decides whether to build a multipart body with `"files" in response`
 * (`Interactions/gateway.js`), not by measuring the array — so an empty array
 * still routes the reply through `withFiles([])`. The key has to be ABSENT,
 * not empty, which a bare `{ files }` would get wrong every time
 * `RULES_GIF_DIR` is unset (dev, tests, and any non-container run).
 */
export const filesField = (files: ReadonlyArray<File>): { readonly files?: ReadonlyArray<File> } =>
  files.length === 0 ? {} : { files };
