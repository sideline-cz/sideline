// TDD — written BEFORE `src/services/expenseAttachmentLimits.ts` exists (plan Task 7a).
// Until Task 3a lands this file fails at module resolution; that is the first red.
//
// Pure module: no Effect, no DB, no mocks. Everything here is bytes in, verdict out.

import { describe, expect, it } from 'vitest';
import {
  type AttachmentCheck,
  checkExpenseAttachment,
  isAllowedContentType,
  MAX_EXPENSE_ATTACHMENT_BYTES,
  normalizeContentType,
  sniffMatches,
} from '~/services/expenseAttachmentLimits.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// 4-byte big-endian box SIZE, then `ftyp` at offset 4, then the brand `heic` at offset 8.
const HEIC = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a

/** `size` bytes whose first bytes are `prefix`; the rest are zeros. */
const padded = (prefix: Uint8Array, size: number): Uint8Array => {
  const out = new Uint8Array(size);
  out.set(prefix.subarray(0, Math.min(prefix.length, size)), 0);
  return out;
};

const ok: AttachmentCheck = { ok: true };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkExpenseAttachment', () => {
  it('should accept a PDF declared as application/pdf', () => {
    expect(checkExpenseAttachment('application/pdf', PDF)).toEqual(ok);
  });

  it('should accept a JPEG declared as image/jpeg', () => {
    expect(checkExpenseAttachment('image/jpeg', JPEG)).toEqual(ok);
  });

  it('should accept a PNG declared as image/png', () => {
    expect(checkExpenseAttachment('image/png', PNG)).toEqual(ok);
  });

  it('should accept a HEIC whose ftyp box starts at offset 4, not 0', () => {
    expect(checkExpenseAttachment('image/heic', HEIC)).toEqual(ok);
    // An implementation that anchors `ftyp` at offset 0 would also match nothing here, so pin
    // the negative: PNG bytes must never satisfy the HEIC signature.
    expect(sniffMatches('image/heic', PNG)).toBe(false);
  });

  it('should reject a declared type that is not on the allowlist', () => {
    expect(checkExpenseAttachment('image/gif', GIF)).toEqual({
      ok: false,
      reason: 'type_not_allowed',
    });
  });

  it('should reject PNG bytes declared as application/pdf', () => {
    // The attacker case: the declared value is theirs, the bytes are the truth.
    expect(checkExpenseAttachment('application/pdf', PNG)).toEqual({
      ok: false,
      reason: 'content_mismatch',
    });
  });

  it('should reject a file one byte over the 5 MB cap', () => {
    expect(
      checkExpenseAttachment('application/pdf', padded(PDF, MAX_EXPENSE_ATTACHMENT_BYTES + 1)),
    ).toEqual({ ok: false, reason: 'too_large' });
  });

  it('should accept a file of exactly MAX_EXPENSE_ATTACHMENT_BYTES — the boundary is inclusive', () => {
    expect(
      checkExpenseAttachment('application/pdf', padded(PDF, MAX_EXPENSE_ATTACHMENT_BYTES)),
    ).toEqual(ok);
  });

  it('should reject empty bytes with content_mismatch and not throw', () => {
    expect(() => checkExpenseAttachment('application/pdf', new Uint8Array(0))).not.toThrow();
    expect(checkExpenseAttachment('application/pdf', new Uint8Array(0))).toEqual({
      ok: false,
      reason: 'content_mismatch',
    });
  });

  it('should reject bytes shorter than the signature with content_mismatch', () => {
    expect(checkExpenseAttachment('image/png', Uint8Array.from([0x89, 0x50]))).toEqual({
      ok: false,
      reason: 'content_mismatch',
    });
    // Same for the HEIC check, whose minimum readable length is 12 bytes.
    expect(checkExpenseAttachment('image/heic', HEIC.subarray(0, 6))).toEqual({
      ok: false,
      reason: 'content_mismatch',
    });
  });

  it('should normalize the declared content type before matching it', () => {
    expect(checkExpenseAttachment('APPLICATION/PDF; charset=binary', PDF)).toEqual(ok);
  });

  it('should check size before the sniff', () => {
    // 6 MB of zeros declared as a disallowed type: `too_large` proves size came first.
    expect(checkExpenseAttachment('image/gif', new Uint8Array(6 * 1024 * 1024))).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('should accept a PDF whose %PDF- header is preceded by junk bytes', () => {
    // Scanner and MFP output does this routinely; an offset-0 implementation 415s a real invoice.
    const junked = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, ...PDF]);
    expect(checkExpenseAttachment('application/pdf', junked)).toEqual(ok);
  });

  it('should reject a PDF header that appears after the first 1024 bytes', () => {
    // Bounds the search so it stays a constant-cost scan rather than a full-file strstr.
    const late = new Uint8Array(1100 + PDF.length);
    late.set(PDF, 1100);
    expect(checkExpenseAttachment('application/pdf', late)).toEqual({
      ok: false,
      reason: 'content_mismatch',
    });
  });
});

describe('normalizeContentType', () => {
  it('should strip parameters and lowercase the declared type', () => {
    expect(normalizeContentType('APPLICATION/PDF; charset=binary')).toBe('application/pdf');
    expect(normalizeContentType('  image/JPEG  ')).toBe('image/jpeg');
  });
});

describe('isAllowedContentType', () => {
  it('should accept the four allowed types and nothing else', () => {
    expect(isAllowedContentType('application/pdf')).toBe(true);
    expect(isAllowedContentType('image/jpeg')).toBe(true);
    expect(isAllowedContentType('image/png')).toBe(true);
    expect(isAllowedContentType('image/heic')).toBe(true);
    expect(isAllowedContentType('image/gif')).toBe(false);
    expect(isAllowedContentType('')).toBe(false);
  });
});
