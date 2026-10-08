// Pure — no Effect, no DB. Mirrors `emailAttachmentLimits.ts`, so it unit-tests standalone.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_EXPENSE_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB

export const ALLOWED_EXPENSE_ATTACHMENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
] as const;
export type AllowedExpenseAttachmentType = (typeof ALLOWED_EXPENSE_ATTACHMENT_TYPES)[number];

export type AttachmentCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'too_large' | 'type_not_allowed' | 'content_mismatch' };

// ---------------------------------------------------------------------------
// Declared content type
// ---------------------------------------------------------------------------

/** `application/pdf; charset=binary` and `APPLICATION/PDF` are the same declaration. */
export const normalizeContentType = (value: string): string =>
  (value.split(';')[0] ?? '').trim().toLowerCase();

export const isAllowedContentType = (value: string): value is AllowedExpenseAttachmentType =>
  (ALLOWED_EXPENSE_ATTACHMENT_TYPES as ReadonlyArray<string>).includes(value);

// ---------------------------------------------------------------------------
// Magic bytes — the declared type is attacker-controlled, the bytes are the truth
// ---------------------------------------------------------------------------

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const PDF_SEARCH_WINDOW = 1024;
const JPEG_SOI = [0xff, 0xd8, 0xff];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const FTYP = [0x66, 0x74, 0x79, 0x70]; // ISO-BMFF box type, at offset 4 (offset 0 is the box size)
// iPhone files are `heic`, `heix` or `mif1`; the rest are the sibling brands of the same spec.
const HEIC_BRANDS = [
  'heic',
  'heix',
  'hevc',
  'hevx',
  'mif1',
  'msf1',
  'heim',
  'heis',
  'hevm',
  'hevs',
];

const startsWithAt = (bytes: Uint8Array, offset: number, signature: ReadonlyArray<number>) => {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
};

/**
 * The PDF spec permits `%PDF-` anywhere within the first 1024 bytes, and scanner/MFP output
 * routinely emits junk ahead of it. Anchoring at offset 0 would 415 a legitimate scanned
 * invoice — the single most likely file in this feature.
 */
const containsPdfHeader = (bytes: Uint8Array) => {
  const limit = Math.min(bytes.length, PDF_SEARCH_WINDOW) - PDF_HEADER.length;
  for (let start = 0; start <= limit; start++) {
    if (startsWithAt(bytes, start, PDF_HEADER)) return true;
  }
  return false;
};

/** True when `bytes` actually carries the signature of `type`. Short input is false, never a throw. */
export const sniffMatches = (type: AllowedExpenseAttachmentType, bytes: Uint8Array): boolean => {
  switch (type) {
    case 'application/pdf':
      return containsPdfHeader(bytes);
    case 'image/jpeg':
      return startsWithAt(bytes, 0, JPEG_SOI);
    case 'image/png':
      return startsWithAt(bytes, 0, PNG_SIGNATURE);
    case 'image/heic':
      return (
        bytes.length >= 12 &&
        startsWithAt(bytes, 4, FTYP) &&
        HEIC_BRANDS.includes(String.fromCharCode(...bytes.subarray(8, 12)))
      );
  }
};

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/** Size first (a 50 MB upload should not be sniffed), then the allowlist, then the bytes. */
export const checkExpenseAttachment = (
  declaredContentType: string,
  bytes: Uint8Array,
): AttachmentCheck => {
  if (bytes.byteLength > MAX_EXPENSE_ATTACHMENT_BYTES) return { ok: false, reason: 'too_large' };
  const type = normalizeContentType(declaredContentType);
  if (!isAllowedContentType(type)) return { ok: false, reason: 'type_not_allowed' };
  if (!sniffMatches(type, bytes)) return { ok: false, reason: 'content_mismatch' };
  return { ok: true };
};
