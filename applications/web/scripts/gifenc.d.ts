/**
 * `gifenc` ships no type declarations. Declared here rather than reached for
 * with `any` — only the four members the renderer uses are described, so an
 * upstream change to any of them is a compile error rather than a runtime one.
 *
 * The module is CJS, so its named exports arrive on the default binding; the
 * shape below matches how `render-rules-gifs.ts` destructures it.
 */
declare module 'gifenc' {
  interface GifFrameOptions {
    readonly palette: ReadonlyArray<ReadonlyArray<number>>;
    /** Frame delay in HUNDREDTHS of a second, not milliseconds. */
    readonly delay?: number;
  }

  interface GifEncoderInstance {
    writeFrame(index: Uint8Array, width: number, height: number, options: GifFrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
  }

  interface GifEnc {
    GIFEncoder(): GifEncoderInstance;
    /** Builds a palette of at most `maxColors` entries from RGBA pixels. */
    quantize(rgba: Uint8Array, maxColors: number): ReadonlyArray<ReadonlyArray<number>>;
    /** Maps RGBA pixels onto `palette`, returning one index per pixel. */
    applyPalette(rgba: Uint8Array, palette: ReadonlyArray<ReadonlyArray<number>>): Uint8Array;
  }

  const gifenc: GifEnc;
  export default gifenc;
}
