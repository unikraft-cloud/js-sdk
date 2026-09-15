---
name: js-sdk-map
description: Maps the repositories and layers behind `@unikraft/cloud`, and says which one owns each decision. Use when editing `src/api` or `templates/`, when a commit type or a version needs choosing, when a porcelain resource wraps a plugin plumbing package, when an install nests a second copy of the SDK or a peer range fails to resolve, when a release or a dist-tag looks wrong, or when the live e2e suite must run.
---

# js-sdk map

This repository is one of five that build `@unikraft/cloud`. Find the owner
here, then read that owner's own documentation. The architecture, the release
channels, and the promotion procedure live in `CONTRIBUTING.md`; this skill
carries only what no file in the repository confesses.

## Who owns what

| Repository | Owns |
| --- | --- |
| `unikraft-cloud/js-sdk` | **This repo.** The transport (`src/core`), the porcelain (`src/resources`), the generated platform plumbing (`src/api`), and the templates that generate it. |
| `unikraft-cloud/openapi` | The compiled platform specs, one branch per channel. `make generate` reads them. |
| `unikraft-cloud/plugins` | Each plugin's `api.tsp`, and every publish workflow, including the one that republishes a plugin plumbing package. |
| `unikraft-cloud/plugin-sdk` | `tsplugingen`, which generates the `@unikraft/cloud-plugin-<name>-api` packages and derives their peer range. |
| `unikraft-cloud/x` | `tools/openapi-gen`, the template engine behind `make generate`. |

## Two kinds of plumbing

- `src/api/**/*.gen.ts` is generated **into** this repository. Edit
  `templates/`, never the output. `CONTRIBUTING.md` has the regeneration
  procedure and its gotchas.
- `@unikraft/cloud-plugin-<name>-api` is generated **outside** this repository
  and published to npm. It is the one class of runtime dependency this package
  accepts. The porcelain for a plugin lives in `src/resources/<name>/` and
  holds a plumbing client, it does not extend one.

## The version comes from the commit subject

`package.json` says `0.0.0` on every branch, and stays that way. The release
workflow derives the real version from the conventional-commit history at
publish time, so the commit type is load-bearing: `feat:` bumps the minor,
`fix:` the patch. Read "Versioning" in `CONTRIBUTING.md` before you choose a
subject or squash a branch.

## The nested-copy hazard

A plugin plumbing package declares `@unikraft/cloud` as a peer, with a range
`tsplugingen` derives from the SDK version at its publish time. Two facts
follow:

- **In this repository, the peer never resolves to the root.** The root
  project is `0.0.0`, which no published range matches, so the resolver nests
  a registry copy of the SDK for the plugin to import. Two copies of
  `core/http.ts` then coexist, and `instanceof` fails across them. Cross-copy
  code paths use `isUnikraftCloudError` (`src/core/http.ts`) instead.
- **On the `next` channel, every published range goes stale at each staging
  cycle.** npm matches a prerelease only against a range that names the same
  `major.minor.patch` tuple, so when `next` moves to a new tuple, consumers
  nest a second SDK copy until the plugin package is republished. The
  republish is one workflow dispatch in `plugins`.

## Tests and package checks

- `npm test` is hermetic; `vitest.config.ts` excludes `test/e2e`.
- `npm run test:e2e` boots real virtual machines. It needs `UKC_TOKEN`, reads
  `.env`, and defaults to the internal staging metro; see `test/e2e/live.ts`.
- `npm run check:package` packs the tarball and loads every `exports` subpath
  from an ESM and a CommonJS consumer. It is the only check that exercises the
  package the way a consumer does, so run it after any change to `exports`,
  `files`, or a dependency.
