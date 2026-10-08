// A `content-disposition` value containing a non-latin1 character makes Node's `writeHead` throw
// `ERR_INVALID_CHAR`, which meant a Czech-named invoice uploaded fine and could then never be
// downloaded. These tests pin both halves of the RFC 6266 fix: the real name round-trips through
// `filename*`, and the ASCII fallback is still header-injection-proof.

import { describe, expect, it } from '@effect/vitest';
import { attachmentContentDisposition } from '~/utils/contentDisposition.js';

// Everything a Node header value accepts. Anything outside this range is what used to throw.
const isLatin1 = (value: string) => [...value].every((c) => c.charCodeAt(0) <= 0xff);

describe('attachmentContentDisposition', () => {
  it('round-trips a Czech filename through filename* and keeps the header latin1', () => {
    const header = attachmentContentDisposition('Faktura_květen.pdf');

    expect(header).toContain("filename*=UTF-8''");
    const encoded = header.split("filename*=UTF-8''")[1];
    expect(decodeURIComponent(encoded ?? '')).toBe('Faktura_květen.pdf');
    expect(isLatin1(header)).toBe(true);
    // The fallback folds the non-ASCII character rather than dropping it.
    expect(header).toContain('filename="Faktura_kv_ten.pdf"');
  });

  it('neutralises a CR/LF header-injection attempt in both forms', () => {
    const header = attachmentContentDisposition('a\r\nSet-Cookie: x=1\r\n\r\n.pdf');

    expect(header).not.toContain('\r');
    expect(header).not.toContain('\n');
    expect(header).toContain('filename="a__Set-Cookie: x=1____.pdf"');
    // The encoded form escapes rather than strips, so the bytes are preserved but inert.
    expect(header).toContain('%0D%0A');
  });

  it('escapes quotes and directive separators in the ASCII fallback', () => {
    const header = attachmentContentDisposition('in"voice;a,b\\c.pdf');

    expect(header).toContain('filename="in_voice_a_b_c.pdf"');
  });

  it('percent-encodes the characters encodeURIComponent leaves outside attr-char', () => {
    const header = attachmentContentDisposition("f'(a)*.pdf");

    const encoded = header.split("filename*=UTF-8''")[1];
    expect(encoded).toBe('f%27%28a%29%2A.pdf');
    expect(decodeURIComponent(encoded ?? '')).toBe("f'(a)*.pdf");
  });
});
