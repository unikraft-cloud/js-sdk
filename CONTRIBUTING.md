# Contributing to `@unikraft/cloud`

Thanks for your interest in improving the Unikraft Cloud JavaScript SDK!

## Architecture

The SDK is deliberately split into two layers:

```
src/
  api/              # the "plumbing" layer — raw, spec-shaped
    platform/       #   GENERATED (*.gen.ts): one class per resource + models
    controlplane/   #   GENERATED (*.gen.ts)
    */index.ts      #   hand-written barrel + PlatformApi / ControlPlaneApi container
    index.ts        #   the Api container behind `ukc.api`
  core/             # hand-written shared machinery
    http.ts         #   transport, errors, CallOptions
    metro.ts        #   metros, scopes, endpoints
    session.ts      #   shared credentials + memoised metro discovery
    fanout.ts       #   run one operation across many metros, merge, aggregate errors
    handle.ts       #   the chainable, lazily-evaluated ResourceHandle
    handle-set.ts   #   each(): one handle per metro holding the same name
    resource.ts     #   Resource base: scope, locating a ref, grouping bulk ops
    patch.ts        #   patch objects and the staged edit() builder
    pagination.ts   #   cursor-following iteration
    response.ts     #   envelope unwrapping and refs
  resources/        # the "porcelain" layer — hand-written idiomatic clients
  index.ts          # the top-level UnikraftCloud client, scopes, and public exports
templates/          # Go templates consumed by openapi-gen to produce src/api/**/*.gen.ts
```

Everything matching `src/api/**/*.gen.ts` is generated from the
[OpenAPI specification][openapi] and **must not be edited by hand** — changes
would be lost on the next regeneration. To change generated output, edit the
templates in `templates/` (or the generator itself, see below). The `index.ts`
barrels beside the generated files are hand-written and safe to edit.

The two layers are kept apart deliberately:

- **Plumbing** (`src/api/**`) mirrors the specification: `operationId` method
  names, the response envelope untouched, one metro per client. Exported as
  `@unikraft/cloud/api/platform` and `@unikraft/cloud/api/controlplane`.
- **Porcelain** (`src/resources/**`) **holds** a plumbing client on `this.api`
  rather than extending one, so its surface stays small and deliberate: short
  verbs, unwrapped results, auto-pagination, metro fan-out, chainable handles.

Because the layers are composed rather than inherited, a newly generated
operation does **not** appear on the idiomatic client automatically — it is
reachable at `ukc.instances.api.newOperation(...)` (or `ukc.api.platform.*`)
until someone wraps it. Wrap only where it improves the developer experience.

When adding a porcelain method, keep the metro rules in `src/core/resource.ts`.
Reads fan out across the scope and tag results with `metro`. A name only
identifies a resource *within* a metro, so a ref may match in several: use
`locate()` when the operation acts on one (it throws `AmbiguousRefError`, with
the matches attached, rather than guessing), `locateAll()` when it acts on all of
them (`each()`, bulk ops), and `oneEndpoint()` for creation. Refs reaching the
wire must go through `wireRef()` — `metro` says where to send the request and the
API rejects it inside a body.

## Prerequisites

- Node.js 18+
- Go 1.23+ (only needed to regenerate `src/api`)

```sh
npm install
```

## Common tasks

```sh
make generate   # regenerate src/api from the OpenAPI spec (default channel: prod-staging)
make build      # build the dual ESM + CJS distribution
make typecheck  # tsc --noEmit over the whole project
make lint       # biome check
make test       # vitest
```

## Regenerating the client

```sh
make generate                     # prod-staging channel
make generate CHANNEL=prod-stable # stable channel
```

`make generate` runs [`openapi-gen`][openapi-gen] against the channel's
`platform.json` and `controlplane.json`, writing TypeScript into
`src/api/platform` and `src/api/controlplane` respectively, then formats it with
Biome. The spec-independent HTTP transport lives in the hand-written
`src/core/http.ts` and is shared by both.

> [!NOTE]
> Some read operations (instance logs, `wait`, image queries, autoscale policy
> listing, …) still model their filters as a request body on a `GET` in the
> spec. The Fetch standard forbids `GET`/`HEAD` bodies and no JS runtime can
> send one, so `templates/resources.tmpl` **deliberately drops the request body
> of every `GET`/`HEAD` operation** and emits only its query parameters — the
> spec exposes the same filters as repeatable query parameters (`?uuid=&name=`,
> plus per-operation extras like `?offset=&limit=`). `src/core/http.ts` refuses
> to attach a body to those methods as a second line of defence. If a new `GET`
> operation ever ships body-only filters with no query equivalent, it needs a
> spec fix rather than a template workaround.

> [!IMPORTANT]
> The templates rely on TypeScript-specific helper functions
> (`schemaToTsType`, `paramToTsType`, `qualifyModels`, …) added to `openapi-gen`.
> Until those land in the published tool, build the generator from a local
> checkout and point `OPENAPI_GEN` at the binary:
>
> ```sh
> (cd ../x/tools/openapi-gen && go build -o /tmp/openapi-gen .)
> make generate OPENAPI_GEN=/tmp/openapi-gen
> ```
>
> Build it rather than using `go run`: this repository is not a Go module (so a
> bare `go run ../x/tools/openapi-gen` fails), and `go -C … run .` would change
> the working directory, making `-t ./templates` resolve to the generator's own
> built-in templates instead of this repository's.

Commit the regenerated `src/api` together with the change that motivated it.

## Release channels

There are two channels, mirroring the OpenAPI spec branches:

| Channel        | OpenAPI branch | npm dist-tag |
| -------------- | -------------- | ------------ |
| `prod-stable`  | `prod-stable`  | `latest`     |
| `prod-staging` | `prod-staging` | `next`       |

Pushing to a channel branch publishes the current `package.json` version under
the corresponding dist-tag (see `.github/workflows/release-stable.yaml`). Bump
the version in `package.json` to cut a release. Publishing requires the
`NPM_TOKEN` repository secret.

## Code style

- Formatting and linting are enforced by [Biome](https://biomejs.dev)
  (`npm run lint`). Run `npx biome check --write .` to fix.
- Keep runtime dependencies at zero: rely on the platform `fetch` and standard
  Web/Node APIs.
- Add a test in `test/` for new idiomatic behaviour.

## Commit messages

This repository uses [Conventional Commits][cc]; pull requests targeting
`prod-staging` are validated in CI.

[openapi]: https://github.com/unikraft-cloud/openapi
[openapi-gen]: https://github.com/unikraft-cloud/x/tree/prod-staging/tools/openapi-gen
[cc]: https://www.conventionalcommits.org
