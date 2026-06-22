# @sideline/docs

## 0.2.3

### Patch Changes

- [#421](https://github.com/maxa-ondrej/sideline/pull/421) [`cfa325c`](https://github.com/maxa-ondrej/sideline/commit/cfa325c80c44b6701c52383e700d8f602d76d32f) Thanks [@dependabot](https://github.com/apps/dependabot)! - deps: bump the npm group across 1 directory with 27 updates

## 0.2.2

### Patch Changes

- [#420](https://github.com/maxa-ondrej/sideline/pull/420) [`3c2207d`](https://github.com/maxa-ondrej/sideline/commit/3c2207d056d6ec46032d2a0cc33f953950c58ef1) Thanks [@dependabot](https://github.com/apps/dependabot)! - Bump astro from 6.4.6 to 6.4.8 in the astro group

## 0.2.1

### Patch Changes

- [#408](https://github.com/maxa-ondrej/sideline/pull/408) [`bee5d1d`](https://github.com/maxa-ondrej/sideline/commit/bee5d1dd461cde1e8cefd0f2b79146623f5192a8) Thanks [@dependabot](https://github.com/apps/dependabot)! - Bump @astrojs/mdx from 6.0.2 to 6.0.3

- [#408](https://github.com/maxa-ondrej/sideline/pull/408) [`bee5d1d`](https://github.com/maxa-ondrej/sideline/commit/bee5d1dd461cde1e8cefd0f2b79146623f5192a8) Thanks [@dependabot](https://github.com/apps/dependabot)! - Bump @astrojs/starlight from 0.39.3 to 0.40.0

- [#408](https://github.com/maxa-ondrej/sideline/pull/408) [`bee5d1d`](https://github.com/maxa-ondrej/sideline/commit/bee5d1dd461cde1e8cefd0f2b79146623f5192a8) Thanks [@dependabot](https://github.com/apps/dependabot)! - Bump astro from 6.4.4 to 6.4.6

## 0.2.0

### Minor Changes

- [#223](https://github.com/maxa-ondrej/sideline/pull/223) [`5298870`](https://github.com/maxa-ondrej/sideline/commit/52988703e2827ed558b3cf15a7e7c902fab46a38) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Scaffold `@sideline/docs`, an Astro + Starlight static documentation site served at `/docs` on the main domain. Includes EN-first landing page, introduction, role-based quick starts, guides, API overview, FAQ, changelog, and about pages. CZ locale ships with zero files — Starlight's built-in fallback banner renders EN content for any `/docs/cs/*` URL. The docs container is a two-stage build producing a `nginx:alpine` image that serves static files, with `/health` exposed for healthchecks. The proxy routes `/docs/*` to the new docs container via a new `$var_docs_upstream` map.
