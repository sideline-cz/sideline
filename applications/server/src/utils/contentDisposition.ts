// A `content-disposition` header value may only contain latin1 bytes — Node's `writeHead` throws
// `ERR_INVALID_CHAR` otherwise, which made every Czech-named attachment (`Faktura_květen.pdf`)
// uploadable but permanently undownloadable. RFC 6266/5987 is the fix: the ASCII `filename="..."`
// stays as the fallback for ancient clients, and `filename*=UTF-8''...` carries the real name
// percent-encoded. Every modern browser prefers `filename*` when both are present.
//
// Used by BOTH attachment download endpoints (expenses, email-forwarding) — do not inline a copy.

// RFC 5987 attr-char is token minus `()<>@,;:\"/[]?={} ` plus `!#$&+-.^_`|~`. `encodeURIComponent`
// leaves `!'()*` unescaped, of which `'()*` are not attr-char, so escape those four too.
const encodeRfc5987 = (value: string): string =>
  encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * Builds a `content-disposition: attachment` value that survives a non-ASCII filename.
 *
 * The ASCII fallback keeps the original stripping — CR/LF, quotes, semicolons, commas and
 * backslashes would let a header be split or a second directive injected — and additionally folds
 * every non-printable-ASCII character to `_`, because those are what Node rejects. The `filename*`
 * form percent-encodes instead of stripping, so the real name round-trips.
 */
export const attachmentContentDisposition = (filename: string): string => {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;,]/g, '_');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
};
