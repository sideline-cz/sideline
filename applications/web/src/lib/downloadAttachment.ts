import { Data, Effect, Option } from 'effect';
import { getToken } from '~/lib/token';

export class AttachmentDownloadFailed extends Data.TaggedError('AttachmentDownloadFailed') {}

/**
 * Authenticated GET -> blob -> synthetic `<a download>` click -> revoke.
 *
 * Framework-free on purpose: no `tr()` here, the caller owns the copy. Two consumers —
 * `EmailDetailPage` and the expense edit route.
 */
export const downloadAttachment = (
  url: string,
  filename: string,
): Effect.Effect<void, AttachmentDownloadFailed> =>
  getToken.pipe(
    Effect.flatMap((tokenOpt) => {
      const headers: Record<string, string> = {};
      if (Option.isSome(tokenOpt)) {
        headers.Authorization = `Bearer ${tokenOpt.value}`;
      }
      return Effect.tryPromise({
        try: () => fetch(url, { headers }),
        catch: () => new AttachmentDownloadFailed(),
      });
    }),
    Effect.flatMap((response) =>
      response.ok
        ? Effect.tryPromise({
            try: () => response.blob(),
            catch: () => new AttachmentDownloadFailed(),
          })
        : Effect.fail(new AttachmentDownloadFailed()),
    ),
    Effect.flatMap((blob) =>
      Effect.sync(() => {
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(objectUrl);
      }),
    ),
  );
