/**
 * Plan `.work-plans/fio-transaction-matching.md` T10 — a thin `qrcode` wrapper. Pure rendering
 * only: the caller (`api/bank-sync.ts`) builds the SPAYD payload via
 * `@sideline/domain`'s `Spayd.buildSpayd` and passes the already-built string in.
 *
 * Deliberately a plain function, NOT a `ServiceMap.Service` — `qrcode` has no state and no
 * config to inject, and the bank-sync API group's own test harness (`test/integration/api/
 * bankSync.test.ts`'s "SmallApi") composes a deliberately minimal layer stack that must fully
 * resolve (`HR = never`) without needing a dedicated QR layer wired in.
 */
import { Data, Effect } from 'effect';
import * as QRCode from 'qrcode';

export class QrRenderError extends Data.TaggedError('QrRenderError')<{
  readonly message: string;
}> {}

export const renderQrPng = (payload: string): Effect.Effect<Uint8Array, QrRenderError> =>
  Effect.tryPromise({
    try: () => QRCode.toBuffer(payload, { type: 'png', errorCorrectionLevel: 'M', margin: 2 }),
    catch: (cause) =>
      new QrRenderError({ message: cause instanceof Error ? cause.message : String(cause) }),
  });
