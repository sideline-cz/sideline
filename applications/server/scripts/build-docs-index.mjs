#!/usr/bin/env node
/**
 * `codegen` step — turns the end-user docs (`applications/docs/src/content/docs`) into a flat
 * section index the assistant's `search_docs` tool searches at runtime.
 *
 * Bundled at build time rather than fetched: the docs are a SEPARATE nginx container
 * (`applications/docs/Dockerfile`), so a runtime fetch would let a newer docs container describe
 * a server that does not behave that way yet. Generating from the same checkout that builds the
 * server pins the docs to the code that ships them.
 *
 * Emits a `.ts` module, not JSON, deliberately: a generated `.ts` file is compiled by `tsc` like
 * any other source and sidesteps all three traps in AGENTS.md's "Shipping JSON Assets From a
 * Package" (the `with { type: 'json' }` import attribute, the `include` glob needed under this
 * repo's composite layout, and the `postbuild` assertion that the asset actually reached `dist/`).
 *
 * The output is gitignored. `applications/server/Dockerfile` copies the docs content into the
 * build stage for this script's sake — the server image otherwise has no reason to know
 * `applications/docs` exists.
 *
 * Wired into BOTH `codegen` and `build`, and the duplication is load-bearing: of the five CI jobs
 * in `.github/workflows/check.yml`, only `Types` runs `pnpm codegen` before `pnpm build`. `Test`,
 * `Test (Europe/Helsinki)` and `Integration Test` go straight to `pnpm build`, so a `codegen`-only
 * wiring left them compiling against a module that does not exist (`TS2307`). Having `build`
 * generate its own input removes the ordering dependency everywhere — CI, Docker and local alike.
 * Running it twice is harmless; it is deterministic and overwrites.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(path.dirname(serverDir));
const contentDir = path.join(repoRoot, 'applications', 'docs', 'src', 'content', 'docs');
const outFile = path.join(serverDir, 'src', 'services', 'ai', 'generated', 'docsIndex.ts');

/**
 * `changelog.md` is 116 KB of release notes nobody asks the assistant about, and the legal pages
 * are verbatim policy text that must be read in full on the real page rather than paraphrased by
 * a model. Both are excluded from the index, never summarised.
 */
const isExcluded = (slug) => slug === 'changelog' || /(^|\/)legal\//.test(slug);

/** Per-section cap. The tool clamps the COMBINED result again; this bounds one pathological section. */
const MAX_SECTION_CHARS = 4000;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) {
      out.push(full);
    }
  }
  return out;
}

const stripFrontmatter = (raw) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) {
    return { meta: {}, body: raw };
  }
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) {
      meta[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '').trim();
    }
  }
  return { meta, body: raw.slice(match[0].length) };
};

/**
 * MDX cleanup. JSX TAGS are dropped but their text content is kept — `<Aside type="caution">The
 * assistant is read-only</Aside>` carries a sentence a user might well ask about, and throwing
 * away the whole element would lose it.
 */
const stripMdx = (body) =>
  body
    .replace(/^import\s+.*?from\s+['"].*?['"];?\s*$/gm, '')
    .replace(/^export\s+const\s+.*$/gm, '')
    // Capitalised tag names ONLY. MDX components are always capitalised (`Aside`, `Steps`,
    // `Badge`, `TabItem`…), while these docs use lowercase angle brackets for CLI placeholders —
    // `/summarize [since:<datetime>]`. A case-insensitive pattern ate those placeholders.
    .replace(/<\/?[A-Z][\w.]*(\s[^>]*?)?\/?>/g, ' ')
    .replace(/:::[a-z]+(\[[^\]]*\])?/g, ' ')
    .replace(/:::/g, ' ');

const normalise = (text) => text.replace(/\s+/g, ' ').trim();

const clamp = (text) =>
  text.length > MAX_SECTION_CHARS ? `${text.slice(0, MAX_SECTION_CHARS - 1)}…` : text;

/** Splits on h2 AND h3: `faq.md` puts every individual question at h3 under a broad h2. */
const HEADING = /^(#{2,3})\s+(.*)$/;

const toSections = (slug, title, body) => {
  const sections = [];
  let heading = '';
  let buffer = [];
  const flush = () => {
    const text = clamp(normalise(buffer.join('\n')));
    if (text.length > 0) {
      sections.push({ slug, title, heading, text });
    }
    buffer = [];
  };
  for (const line of body.split(/\r?\n/)) {
    const match = HEADING.exec(line);
    if (match) {
      flush();
      heading = normalise(match[2].replace(/[*_`]/g, ''));
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
};

async function main() {
  let files;
  try {
    files = await walk(contentDir);
  } catch (err) {
    throw new Error(
      `docs content not found at ${contentDir} — the server Dockerfile must COPY applications/docs/src/content into the build stage (${err.message})`,
    );
  }

  const sections = [];
  for (const file of files.sort()) {
    const slug = path
      .relative(contentDir, file)
      .replace(/\\/g, '/')
      .replace(/\.(md|mdx)$/, '');
    if (isExcluded(slug)) {
      continue;
    }
    const { meta, body } = stripFrontmatter(await readFile(file, 'utf8'));
    sections.push(...toSections(slug, meta.title ?? slug, stripMdx(body)));
  }

  // An empty index must never build green: `search_docs` would answer every question with
  // "nothing found" and look like a model problem rather than a build one.
  if (sections.length === 0) {
    throw new Error(
      `no docs sections produced from ${contentDir} — refusing to emit an empty index`,
    );
  }

  const contents = `// GENERATED by scripts/build-docs-index.mjs — do not edit, do not commit.
// Source: applications/docs/src/content/docs (changelog and legal excluded).

export interface DocsSection {
  readonly slug: string;
  readonly title: string;
  readonly heading: string;
  readonly text: string;
}

export const DOCS_SECTIONS: ReadonlyArray<DocsSection> = ${JSON.stringify(sections, null, 2)};
`;

  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, contents, 'utf8');
  console.log(
    `build-docs-index: ${sections.length} sections from ${files.length} files -> ${path.relative(repoRoot, outFile)}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
