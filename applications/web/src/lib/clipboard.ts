/**
 * Copy `text` to the clipboard, returning whether the write succeeded.
 *
 * Guards against a missing `navigator.clipboard` (insecure contexts / older
 * browsers) and swallows the rejection that `writeText` can throw on permission
 * denial, so callers never see an unhandled rejection. Callers are responsible
 * for any success side-effect (e.g. showing a "copied" hint), keyed off the
 * resolved boolean.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  if (!navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.warn('copyToClipboard failed', error);
    return false;
  }
}
