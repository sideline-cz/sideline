/**
 * Renders each rules situation to animated GIFs, ahead of time.
 *
 * **Why this exists at all:** the trainer teaches by freezing an animated play
 * at `qAt` and only revealing the resolution once the chain is answered. In
 * Discord there is no canvas to animate, so the animation has to arrive as a
 * file — see `docs/plans/rules-trainer.md`.
 *
 * **Why ahead of time rather than on demand:** the 109 scenarios are static
 * content that never changes at runtime, and a Discord slash command must
 * acknowledge within 3 seconds. Rendering per interaction would put a
 * rasteriser and an encoder in the bot image and race that budget for no
 * benefit.
 *
 * **Why two clips per scenario:** `animLimit` (`@sideline/rules`) proves there
 * are exactly two states worth encoding, not a continuum — `qAt` before the
 * chain is answered, `dur` after. Both are cut from ONE frame sequence, so the
 * second clip costs only its encode.
 *
 * The payoff beyond fidelity: in a precomputed setup clip the frames past
 * `qAt` are *not in the file the viewer has*. On web the spoiler gate is a UI
 * promise — the later frames exist and something declines to draw them. Here
 * nobody can scrub past what was never encoded.
 *
 * Run: `pnpm --filter @sideline/web render:gifs [-- --scenario s1] [--out DIR]`
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import type { Lang, Scenario } from '@sideline/rules';
import { ALL_PACKAGES } from '@sideline/rules/content';
// `gifenc` is CJS, so its named exports arrive on the default binding rather
// than as ESM named exports — importing them directly fails at module load.
import gifenc from 'gifenc';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RulesFieldSvg } from '~/components/organisms/RulesFieldSvg.js';

/**
 * 12fps, not 30. This is flat vector art whose motion is a few discs and
 * players gliding along smooth paths — the frame budget buys far less here
 * than it would for video, and GIF pays for every frame in palette table and
 * bytes. 12 is the lowest rate at which the disc still reads as travelling
 * rather than teleporting.
 */
const FPS = 10;

/**
 * 480px wide, 32 colours. Measured on `s1`, whose 7.2s resolution clip is
 * among the longest:
 *
 * | settings           | per clip | 109 scenarios | render |
 * |--------------------|----------|---------------|--------|
 * | 640px 12fps 64col  |  704 KiB |    ~120 MiB   | 5.5 min|
 * | 480px 10fps 32col  |  340 KiB |     ~58 MiB   | 3.3 min|
 * | 400px  8fps 32col  |  218 KiB |     ~37 MiB   | 2.3 min|
 *
 * 480/10/32 is the point where actor labels (`O1`, `D3`) are still legible and
 * the disc still reads as travelling. Per-file size was never the constraint —
 * even 704 KiB clears any Discord attachment limit comfortably — the total
 * asset weight is.
 */
const WIDTH = 480;

/** The pitch is a handful of flat greens plus white lines and three marker
 * colours, so 32 entries is ample; the cost of more is paid on every frame. */
const PALETTE_COLORS = 32;

/** GIF delay is expressed in hundredths of a second, not milliseconds. */
const FRAME_DELAY_CS = Math.round(100 / FPS);

const { GIFEncoder, applyPalette, quantize } = gifenc;

const locale: Lang = 'en';

interface Clip {
  readonly suffix: 'setup' | 'resolution';
  readonly until: number;
}

/** The two states `animLimit` distinguishes. `setup` is what a shared channel
 * message may show; `resolution` is only ever delivered privately, after that
 * participant has finished — see the plan. */
const clipsFor = (scenario: Scenario): readonly Clip[] => [
  { suffix: 'setup', until: scenario.qAt },
  { suffix: 'resolution', until: scenario.dur },
];

/** One frame as RGBA pixels, via the SAME React component the web trainer
 * renders — which is what keeps the GIF and the live trainer from drifting. */
/**
 * ⚠️ **`loadSystemFonts` must stay `false`.** resvg-js rebuilds its font
 * database per `Resvg` instance, and this constructs one per frame — with
 * system fonts enabled that measured **966 ms per frame** against **2 ms**
 * without, which is the difference between a ~5 hour render and a ~3 minute
 * one. Text still renders because `fontFiles` supplies exactly what is needed.
 */
const fontOptions = (fontFiles: readonly string[]) => ({
  loadSystemFonts: false,
  fontFiles: [...fontFiles],
  defaultFontFamily: 'sans-serif',
});

const frameRgba = (
  scenario: Scenario,
  t: number,
  fontFiles: readonly string[],
): { data: Uint8Array; width: number; height: number } => {
  // Must go through `createElement`, not a direct call: `RulesFieldSvg` uses
  // `useMemo`, and calling a component as a plain function bypasses React's
  // hook dispatcher (`Cannot read properties of null (reading 'useMemo')`).
  const svg = renderToStaticMarkup(createElement(RulesFieldSvg, { scenario, t, locale }));
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: WIDTH },
    font: fontOptions(fontFiles),
  });
  const rendered = resvg.render();
  return { data: rendered.pixels, width: rendered.width, height: rendered.height };
};

const encodeClip = (scenario: Scenario, clip: Clip, fontFiles: readonly string[]): Uint8Array => {
  const frameCount = Math.max(2, Math.ceil(clip.until * FPS));
  const gif = GIFEncoder();

  for (let i = 0; i < frameCount; i++) {
    // Inclusive of the final instant, so a clip ends exactly on its limit
    // rather than one frame short of it.
    const t = (i / (frameCount - 1)) * clip.until;
    const { data, width, height } = frameRgba(scenario, t, fontFiles);
    // Quantising per frame measured ~3 ms against resvg's ~15 ms, so a shared
    // palette would buy little and would band the pitch on frames whose
    // colours differ (a flash, a highlighted zone).
    const palette = quantize(data, PALETTE_COLORS);
    const indexed = applyPalette(data, palette);
    gif.writeFrame(indexed, width, height, { palette, delay: FRAME_DELAY_CS });
  }

  gif.finish();
  return gif.bytes();
};

/**
 * Candidate text fonts, first existing wins. macOS paths first for local runs,
 * then the Debian/Ubuntu paths a CI image provides via `fonts-dejavu-core` or
 * `fonts-liberation`.
 *
 * ⚠️ Resolving NOTHING is a hard failure, never a warning. resvg silently
 * omits text it has no font for, so the GIFs would encode, look plausible in a
 * listing, and be missing every actor label and call-out — a silent quality
 * regression discovered only by looking at one.
 *
 * Known gap: exactly 10 of 460 fx strings (5 scenarios) contain `✋` U+270B.
 * A plain text font has no glyph for it, so it renders as tofu. Pass a font
 * that covers U+270B via `--font` to fix those; nothing else in the content
 * needs one.
 */
/** Scenarios per child process. 10 keeps peak RSS near 1.5 GiB — comfortable
 * on a 7.8 GiB Docker VM and a 16 GiB CI runner alike — while costing only
 * ~11 process spawns across the whole render. */
const DEFAULT_BATCH = 10;

const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
];

const resolveFonts = (explicit: readonly string[]): readonly string[] => {
  const chosen = explicit.length > 0 ? explicit : FONT_CANDIDATES.filter((f) => existsSync(f));
  const missing = chosen.filter((f) => !existsSync(f));
  if (missing.length > 0) {
    console.error(`font file(s) not found:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
  if (chosen.length === 0) {
    console.error(
      'No usable font found. resvg silently DROPS text it cannot render, so this\n' +
        'would produce GIFs with no actor labels and no call-outs rather than an\n' +
        'error. Install a font (e.g. `fonts-dejavu-core`) or pass --font <path>.\n' +
        `Looked for:\n  ${FONT_CANDIDATES.join('\n  ')}`,
    );
    process.exit(1);
  }
  return chosen;
};

const main = () => {
  const args = process.argv.slice(2);
  const argValue = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };

  // Anchored to this file, not to `process.cwd()`. `pnpm --filter` runs the
  // script with the CWD set to the package — so a repo-relative default wrote
  // 218 files to `applications/web/applications/web/.rules-gifs`, which is
  // exactly what the documented invocation above produces. A relative `--out`
  // still resolves against the CWD, which is what someone typing one expects.
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const outArg = argValue('--out');
  const outDir =
    outArg === undefined
      ? join(REPO_ROOT, 'applications/web/.rules-gifs')
      : isAbsolute(outArg)
        ? outArg
        : resolve(process.cwd(), outArg);
  const only = argValue('--scenario');
  const limit = argValue('--limit');
  const offset = Number.parseInt(argValue('--offset') ?? '0', 10);
  const batch = Number.parseInt(argValue('--batch') ?? String(DEFAULT_BATCH), 10);
  const fontFiles = resolveFonts(
    args.flatMap((a, i) => (a === '--font' ? [args[i + 1] ?? ''] : [])).filter((f) => f !== ''),
  );
  console.log(`fonts: ${fontFiles.join(', ')}`);

  // ── Batching ──────────────────────────────────────────────────────────────
  //
  // resvg-js leaks native memory on Linux that this process cannot reclaim.
  // Measured in the bot's build container: RSS climbs ~100 MiB per scenario,
  // 1.4 GiB by scenario 10 and 3.4 GiB by scenario 20, so the full 109 needs
  // ~11 GiB and gets OOM-killed (exit 137) well before finishing.
  //
  // It is not a GC-timing problem, and it is worth recording what was ruled
  // out so nobody re-runs these:
  //
  //   MALLOC_ARENA_MAX=2      3432 MiB   (glibc arena fragmentation)
  //   --max-old-space-size    3401 MiB   (more frequent collection)
  //   explicit global.gc()    3367 MiB   (--expose-gc, per clip)
  //   baseline                3456 MiB
  //
  // All within noise of each other. `Resvg`/`RenderedImage` expose no free or
  // dispose, so the memory is simply not reachable from JS. macOS does not
  // show it, which is why a local render of all 109 succeeds in 115 s.
  //
  // So the parent renders nothing itself: it re-invokes this script once per
  // batch and lets each child exit, which is the one thing guaranteed to
  // return native memory to the OS. `--batch 0` opts out for a single-process
  // run (useful when profiling, and what each child is invoked with).
  if (batch > 0 && only === undefined && offset === 0) {
    // `--limit` caps the whole run here, not each child — a child's slice size
    // is `--batch`. Without this a `--limit 8` smoke test silently rendered all
    // 109.
    const all = ALL_PACKAGES.flatMap((p) => p.scenarios).length;
    const total = limit === undefined ? all : Math.min(all, Number.parseInt(limit, 10));
    mkdirSync(outDir, { recursive: true });
    const started = Date.now();
    for (let from = 0; from < total; from += batch) {
      // `execArgv` carries tsx's loader hooks; dropping it would hand the
      // child a .ts file bare node cannot parse.
      const result = spawnSync(
        process.execPath,
        [
          ...process.execArgv,
          process.argv[1] ?? '',
          '--out',
          outDir,
          '--offset',
          String(from),
          '--limit',
          String(Math.min(batch, total - from)),
          '--batch',
          '0',
          ...(fontFiles.length > 0 ? fontFiles.flatMap((f) => ['--font', f]) : []),
        ],
        { stdio: 'inherit' },
      );
      if (result.status !== 0) {
        console.error(`batch at offset ${from} failed (status ${result.status})`);
        process.exit(1);
      }
    }
    console.log(
      `\n${total} scenarios in ${Math.ceil(total / batch)} batches of ${batch}, ` +
        `${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
    return;
  }

  const scenarios = ALL_PACKAGES.flatMap((p) => p.scenarios)
    .filter((s) => only === undefined || s.id === only)
    .slice(offset, limit === undefined ? undefined : offset + Number.parseInt(limit, 10));
  if (scenarios.length === 0) {
    console.error(only === undefined ? 'no scenarios found' : `no scenario with id ${only}`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });

  let totalBytes = 0;
  let totalFrames = 0;
  const started = Date.now();

  for (const scenario of scenarios) {
    for (const clip of clipsFor(scenario)) {
      const bytes = encodeClip(scenario, clip, fontFiles);
      const file = join(outDir, `${scenario.id}-${clip.suffix}.gif`);
      writeFileSync(file, bytes);
      totalBytes += bytes.length;
      totalFrames += Math.max(2, Math.ceil(clip.until * FPS));
      console.log(
        `${file}  ${(bytes.length / 1024).toFixed(0)} KiB  ` +
          `${Math.max(2, Math.ceil(clip.until * FPS))} frames  ${clip.until.toFixed(1)}s  ` +
          `rss ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MiB`,
      );
    }
  }

  const seconds = (Date.now() - started) / 1000;
  console.log(
    `\n${scenarios.length} scenario(s), ${scenarios.length * 2} clips, ` +
      `${totalFrames} frames, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB total, ` +
      `${seconds.toFixed(1)}s`,
  );
  if (only === undefined) return;
  // Extrapolation is the point of a single-scenario run: it answers "is this
  // viable at 109?" before anyone spends the full render.
  const all = ALL_PACKAGES.flatMap((p) => p.scenarios).length;
  console.log(
    `extrapolated to ${all} scenarios: ~${((totalBytes / scenarios.length / 1024 / 1024) * all).toFixed(0)} MiB, ` +
      `~${(((seconds / scenarios.length) * all) / 60).toFixed(1)} min`,
  );
};

main();
