# @sideline/proxy

## 0.2.12

### Patch Changes

- [#365](https://github.com/maxa-ondrej/sideline/pull/365) [`c931704`](https://github.com/maxa-ondrej/sideline/commit/c9317041669c68437576931e74832f163a4b521b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Route frontend OTEL telemetry through the nginx proxy to avoid cross-origin issues with the SigNoz collector. The browser OTEL exporter now posts to the same-origin `/otel/` path which nginx proxies to the collector, eliminating CORS preflight failures. Also bumps server to pick up the migrations 0.18.1 patch.

## 0.2.11

### Patch Changes

- [`1c817a0`](https://github.com/maxa-ondrej/sideline/commit/1c817a0279e9923e6bd6f7fbf7368012a32275f7) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Forward `Host: $proxy_host` (the upstream FQDN) instead of `Host: $host` (the client's host) so Host-routed upstream terminators (Coolify ingress, Cloudflare) accept the request. Also fix `X-Forwarded-Host` to carry `$host` (was `$server_name`, which evaluated to `_` from the wildcard `server_name _;`), so apps that need the original incoming host can still recover it. Apps continue to use their `*_URL` env vars for URL generation, so this is transparent to them.

## 0.2.10

### Patch Changes

- [`401065b`](https://github.com/maxa-ondrej/sideline/commit/401065b1d5751e28bdaaef5ec62f69a731217dd7) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Send SNI on the TLS handshake to HTTPS upstreams (`proxy_ssl_server_name on`, `proxy_ssl_name $proxy_host`). Without this, upstreams fronted by SNI-routing TLS terminators (Cloudflare, Coolify ingress, etc.) reject the handshake with `SSL alert number 40` because they can't pick the right certificate. No effect on plain-HTTP upstreams.

## 0.2.9

### Patch Changes

- [`ed42b26`](https://github.com/maxa-ondrej/sideline/commit/ed42b26368d8ea6b0a3efac0442c0b1f5834ec49) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add per-upstream `WEB_SCHEME`, `SERVER_SCHEME`, and `DOCS_SCHEME` env vars (accepting `http` or `https`, defaulting to `http`) so the proxy can reach upstreams that terminate TLS at their own ingress. The startup script composes `${SCHEME}://${HOST}:${PORT}` for each upstream and elides the redundant default port (`:80` for `http`, `:443` for `https`) from the resulting URL. Existing internal-network deployments keep working unchanged because the default scheme stays `http`.

## 0.2.8

### Patch Changes

- [#223](https://github.com/maxa-ondrej/sideline/pull/223) [`5298870`](https://github.com/maxa-ondrej/sideline/commit/52988703e2827ed558b3cf15a7e7c902fab46a38) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Scaffold `@sideline/docs`, an Astro + Starlight static documentation site served at `/docs` on the main domain. Includes EN-first landing page, introduction, role-based quick starts, guides, API overview, FAQ, changelog, and about pages. CZ locale ships with zero files — Starlight's built-in fallback banner renders EN content for any `/docs/cs/*` URL. The docs container is a two-stage build producing a `nginx:alpine` image that serves static files, with `/health` exposed for healthchecks. The proxy routes `/docs/*` to the new docs container via a new `$var_docs_upstream` map.

## 0.2.7

### Patch Changes

- [`90b50bb`](https://github.com/maxa-ondrej/sideline/commit/90b50bbf8317901cedaa7cda8216ecef12be9acc) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Patch bump all applications

## 0.2.6

### Patch Changes

- [`0685679`](https://github.com/maxa-ondrej/sideline/commit/06856798d01a669df8ac7ec38b64aca076e2b888) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Split migrations into before/after lifecycle, decompose DATABASE_URL into individual connection params, and update docker-compose for full-stack deployment.

## 0.2.5

### Patch Changes

- [`894c836`](https://github.com/maxa-ondrej/sideline/commit/894c836d65dc885a94d25d4f280c04c74b4866d0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Simplify version extraction in Docker release workflow

## 0.2.4

### Patch Changes

- [`79f2e9e`](https://github.com/maxa-ondrej/sideline/commit/79f2e9e7271e5ab82acdcff1b72f2e2a3b77f59f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix Docker build: add BuildKit setup and version-based image tags

## 0.2.3

### Patch Changes

- [`e1389ba`](https://github.com/maxa-ondrej/sideline/commit/e1389ba855a70a285581639d349908570456659c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Build and push Docker images for changed applications as part of the release workflow

## 0.2.2

### Patch Changes

- [`8505070`](https://github.com/maxa-ondrej/sideline/commit/850507079ac8e4a9846a34fc365b2c2714ecfa5b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Enable changesets versioning and tagging for private application packages

## 0.2.1

### Patch Changes

- [`db26bc9`](https://github.com/maxa-ondrej/sideline/commit/db26bc9b397f7cd00c866aa7b25873f1528384dd) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Move proxy from .docker/proxy to applications/proxy, replace snapshot workflow with a unified publish workflow that routes npm publishing for packages and Docker builds for applications based on the tagged package name, and separate release PR creation from publishing in the release workflow
