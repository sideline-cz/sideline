import type { Expense, Team } from '@sideline/domain';
import { Data, Effect } from 'effect';
import type { client } from '~/lib/client';

type Client = Effect.Success<typeof client>;

/** The file could not be read off disk — moved, renamed or permission-revoked since the picker. */
export class AttachmentReadFailed extends Data.TaggedError('AttachmentReadFailed') {}

/**
 * FileReader, not `btoa(String.fromCharCode(...new Uint8Array(buf)))` — spreading a 5 MB array
 * into a call blows the argument limit and throws RangeError.
 */
export const toBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    // Without this an aborted read leaves the promise pending forever and the submit button
    // disabled for good.
    reader.onabort = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });

/**
 * `tryPromise`, never `promise`: a `FileReader` rejection typed as `never` is a defect, and a
 * defect flows past the caller's `catchTags`/`mapError` and past `Effect.option` in
 * `runPromiseClient`, rejecting the `await` — no toast at all, and every remaining file in the
 * upload loop silently dropped.
 */
export const readFileBase64 = (file: File): Effect.Effect<string, AttachmentReadFailed> =>
  Effect.tryPromise({
    try: () => toBase64(file),
    catch: () => new AttachmentReadFailed(),
  });

/**
 * Takes the already-resolved api client, so this module imports a type from `~/lib/client` and
 * no service. Errors stay typed (`ExpenseAttachmentTooLarge` etc.); the caller maps them to copy.
 *
 * `file.type` is sent as-is even when empty — some HEIC pickers give an empty string, and the
 * server is the trust boundary, so there is no client-side allowlist here.
 */
export const uploadExpenseAttachment = (
  api: Client,
  teamId: Team.TeamId,
  expenseId: Expense.ExpenseId,
  file: File,
) =>
  readFileBase64(file).pipe(
    Effect.flatMap((contentBase64) =>
      api.expenses.uploadExpenseAttachment({
        params: { teamId, expenseId },
        payload: { filename: file.name, contentType: file.type, contentBase64 },
      }),
    ),
  );

export const buildExpenseAttachmentUrl = (
  serverUrl: string,
  teamId: string,
  expenseId: string,
  attachmentId: string,
): string =>
  `${serverUrl.replace(/\/$/, '')}/teams/${teamId}/expenses/${expenseId}/attachments/${attachmentId}`;
