import type { EmailForwarding } from '@sideline/domain';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB

// ---------------------------------------------------------------------------
// Pure validation function
// ---------------------------------------------------------------------------

export type AttachmentSizeCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export const validateAttachmentSizes = (
  attachments: ReadonlyArray<EmailForwarding.EmailAttachmentPayload>,
): AttachmentSizeCheck => {
  let totalBytes = 0;
  for (const att of attachments) {
    const decoded = Buffer.from(att.content_base64, 'base64').byteLength;
    if (decoded > MAX_ATTACHMENT_BYTES) {
      return { ok: false, reason: 'Attachment too large' };
    }
    totalBytes += decoded;
  }
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    return { ok: false, reason: 'Total attachments too large' };
  }
  return { ok: true };
};
