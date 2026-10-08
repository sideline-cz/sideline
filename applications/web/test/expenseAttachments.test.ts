import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileBase64 } from '~/lib/expenseAttachments.js';

describe('readFileBase64', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should fail with a typed error, not a defect, when the file cannot be read', async () => {
    // The whole point: `Effect.promise` typed this as `Effect<string, never>`, so a FileReader
    // rejection became a DEFECT — invisible to `catchTags`, `mapError` and the `Effect.option`
    // inside `runPromiseClient`, which rejected the `await` in the upload loop. No toast fired and
    // every remaining file was dropped. `Effect.catch` below only ever sees typed failures.
    vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
      this.dispatchEvent(new ProgressEvent('error'));
    });

    const tag = await Effect.runPromise(
      readFileBase64(new File(['x'], 'invoice.pdf', { type: 'application/pdf' })).pipe(
        Effect.catch((e) => Effect.succeed(e._tag)),
      ),
    );

    expect(tag).toBe('AttachmentReadFailed');
  });

  it('should fail rather than hang when the read is aborted', async () => {
    // Without `onabort` the promise never settles: the submit button stays disabled for good.
    vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
      this.dispatchEvent(new ProgressEvent('abort'));
    });

    const tag = await Effect.runPromise(
      readFileBase64(new File(['x'], 'invoice.pdf', { type: 'application/pdf' })).pipe(
        Effect.catch((e) => Effect.succeed(e._tag)),
      ),
    );

    expect(tag).toBe('AttachmentReadFailed');
  });
});
