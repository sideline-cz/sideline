/**
 * Wraps the base64 PNG returned by `Finance/GetPaymentQr` into a Discord `File` + an
 * `attachment://` URL, the same shape `clipAttachment` builds for a rules clip
 * (`src/rest/rules/clips.ts`). The QR is rendered server-side on demand (T10, D-Q8) and never
 * cached here — decoded once per reminder send.
 */

import type { FinanceRpcModels } from '@sideline/domain';

export const paymentQrAttachment = (
  result: FinanceRpcModels.PaymentQrResult,
): { readonly file: File; readonly url: string } => {
  const bytes = Buffer.from(result.png_base64, 'base64');
  return {
    file: new File([bytes as BlobPart], result.filename, { type: 'image/png' }),
    url: `attachment://${result.filename}`,
  };
};
