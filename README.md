# `@unikraft/cloud`

The official JavaScript/TypeScript SDK for the [Unikraft Cloud][ukc] API.

## Installation

```sh
npm install @unikraft/cloud
```

## Quickstart

```ts
import { UnikraftCloud } from "@unikraft/cloud";

const ukc = new UnikraftCloud({ token: process.env.UKC_TOKEN });

// By default the client is account-wide: every metro is asked in parallel and
// the results are merged, each tagged with the metro it came from.
for await (const inst of ukc.instances.list({ details: true })) {
  console.log(inst.metro, inst.name, inst.state);
}

// Creating a resource happens in one metro, so name it.
const fra = ukc.metro("fra");
const instance = await fra.instances.create({
  image: "nginx:latest",
  autostart: true,
  memory_mb: 256,
  service_group: {
    services: [{ port: 443, handlers: ["tls", "http"], destination_port: 80 }],
  },
});

// Operations chain off a reference, so a ref is written once.
await fra.instances.get({ name: instance.name! }).wait({ state: "running" });
await ukc.instances.get({ name: instance.name! }).suspend();
await fra.instances.delete([{ uuid: instance.uuid! }]);
```

## Authentication

Pass a bearer `token` to the constructor, or set the `UKC_TOKEN` environment
variable. Create a token in the [Unikraft Cloud dashboard][dashboard].

## The two layers: porcelain and plumbing

The SDK is explicitly two layers, and you choose per call which one you are in:

| Layer         | Where                                                       | What you get                                                                  |
| ------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Porcelain** | `@unikraft/cloud` — `ukc.instances`, `ukc.volumes`, …       | Short verbs, no envelope, auto-pagination, metro fan-out, chainable handles    |
| **Plumbing**  | `@unikraft/cloud/api/platform`, `.../api/controlplane`      | The OpenAPI specification as written: `operationId` methods, raw envelope, one metro per call |

The porcelain layer **holds** a plumbing client rather than extending one, so the
two never blur together — and the raw client is always one property away:

```ts
// Porcelain: unwrapped, metro-aware.
const inst = await ukc.instances.get({ name: "web" });

// Plumbing, from the same client and credentials.
const res = await ukc.api.platform.instances.getInstances({ count: 10, details: true });
res.status; // "success"
res.data?.instances;

// Plumbing, per resource (the escape hatch for anything not wrapped yet).
await ukc.instances.api.getInstanceLogs({ name: ["web"] });

// Plumbing, standalone — no porcelain involved.
import { InstancesApi, PlatformApi } from "@unikraft/cloud/api/platform";
import { ControlPlaneApi } from "@unikraft/cloud/api/controlplane";

const api = new PlatformApi({
  baseUrl: "https://api.fra.unikraft.cloud",
  token: process.env.UKC_TOKEN,
});
await api.instances.getInstances({ count: 10 });
```

Plumbing clients are metro-scoped by construction: they talk to whatever
`baseUrl` names, and a single call can be redirected with `{ baseUrl }`. Fanning
out across metros is the porcelain layer's job.

### Two APIs: platform and control plane

Both Unikraft Cloud APIs defined by our [OpenAPI][openapi] specification are
wrapped:

- **Platform** — metro-scoped resources (instances, volumes, services,
  certificates, autoscale, images). Wrapped idiomatically at the top level; raw
  under `@unikraft/cloud/api/platform` and `ukc.api.platform`.
- **Control plane** — the global (non-metro) API for account, metros, images and
  self-hosted nodes. Raw only, under `@unikraft/cloud/api/controlplane` and
  `ukc.api.controlplane`.

```ts
for (const metro of (await ukc.api.controlplane.metros.listMetros()).data?.metros ?? []) {
  console.log(metro.iata_code, metro.endpoint);
}
```

## Metros: one account, many regions

The platform API is per-metro, but an account's instances are spread across them.
The porcelain layer treats **the metros in scope** as one namespace: reads fan
out concurrently and are merged, and every result carries the `metro` it came
from.

```ts
const ukc = new UnikraftCloud({ token });

// Every metro the account can reach (discovered once, then cached).
for await (const inst of ukc.instances.list()) console.log(inst.metro, inst.name);

// Explicit scopes — these also skip metro discovery entirely.
ukc.metro("fra").instances.list();            // one metro
ukc.metros(["fra", "dal"]).instances.list();  // several
ukc.instances.list({ metros: ["fra", "dal"] });  // just this call
ukc.instances.list({ metros: "all" });           // back to everything

// What the account can reach.
for (const { metro, baseUrl } of await ukc.availableMetros()) console.log(metro, baseUrl);
```

Set the default scope at construction, too:

```ts
new UnikraftCloud({ token });                      // all metros (default)
new UnikraftCloud({ token, metro: "fra" });        // one metro
new UnikraftCloud({ token, metros: ["fra", "dal"] }); // several
```

`UKC_METRO` acts like `metro:` — setting it pins the client to that metro.

| Code  | Location            |
| ----- | ------------------- |
| `fra` | Frankfurt, DE       |
| `dal` | Dallas, TX, USA     |
| `sin` | Singapore           |
| `was` | Washington, DC, USA |
| `sfo` | San Francisco, USA  |

Metro discovery asks the control plane and trusts the endpoint it reports, so new
metros work without an SDK upgrade. `KNOWN_METROS` lists the ones known when this
version was published.

### Rules the fan-out follows

- **Reads** cover the whole scope. Pages are interleaved in arrival order, so a
  slow metro never holds up a fast one.
- **A name identifies a resource within a metro.** The same name can exist in
  several metros at once — usually because you deployed the same thing
  everywhere — so a name plus a wide scope may match more than one resource. See
  [Names across metros](#names-across-metros).
- **`create` never fans out.** It needs one metro: the client's, or the default
  metro (`metro:` / `UKC_METRO` / `fra`) when the scope is wider.
- **Bulk operations are bounded by the scope.** Refs are located first and one
  call goes to each metro that matched, so `delete([{ name: "web" }])` under a
  wide scope deletes every `web` in scope. Narrow the scope or qualify the ref to
  act on one.
- **The control plane is global**, so it is unaffected by scope.

### Names across metros

Names are scoped to a metro, so the same name can name a different resource in
every metro. Three ways to say what you mean:

```ts
// 1. Qualify the ref. No search, no discovery — one request.
await ukc.instances.get({ name: "web", metro: "fra" }).suspend();

// 2. Narrow the scope, which qualifies every ref through it.
await ukc.metro("fra").instances.get({ name: "web" }).suspend();

// 3. Address every metro holding it, on purpose.
await ukc.instances.each({ name: "web" }).suspend();  // one result per metro
```

`{ uuid }` refs never need qualifying: a UUID identifies one resource wherever it
lives.

`get()` insists on exactly one match, because the next thing you write might be a
mutation. When a name matches in several metros it throws an `AmbiguousRefError`
carrying the matches, so recovering costs no further requests:

```ts
import { AmbiguousRefError } from "@unikraft/cloud";

try {
  await ukc.instances.get({ name: "web" }).suspend();
} catch (err) {
  if (err instanceof AmbiguousRefError) {
    err.metros;   // ["fra", "dal", "sin"]
    err.matches;  // the instances themselves, each tagged with .metro
  }
}
```

`each(ref)` is the deliberate plural. It resolves the matches once, then runs each
operation in the metro that holds it:

```ts
const web = ukc.instances.each({ name: "web" });

await web.where();                      // ["fra", "dal", "sin"]
await web.size();                       // 3
for (const inst of await web) …         // the instances
await web.suspend();                    // one result per metro
await web.edit().set({ memory_mb: 512 }).apply();
```

Set operations return arrays and follow the same partial-failure rule as reads:
successes are returned on the thrown `MetroFanoutError` as `err.results`.
`each()` exists on instances, volumes, services and certificates.

### Partial failure

A metro that is unreachable does not throw away the rest of the answer. Healthy
metros are drained first, then a `MetroFanoutError` naming the failures is
thrown:

```ts
import { MetroFanoutError } from "@unikraft/cloud";

try {
  for await (const inst of ukc.instances.list()) use(inst); // fra, dal, was delivered
} catch (err) {
  if (err instanceof MetroFanoutError) {
    err.message;  // "1 of 4 metros failed: sin (503)"
    err.failures; // [{ metro: "sin", error: UnikraftCloudError }]
  }
}
```

For a bulk operation, which cannot yield as it goes, the results that did succeed
are attached to the thrown error as `err.results`.

## Chainable handles

Single-resource operations return a **handle**: a lazily-evaluated reference to
one resource in one metro. Awaiting a handle gives the resource; calling an
operation on it returns another handle:

```ts
await ukc.instances.get({ name: "web" });            // -> Instance
await ukc.instances.get({ name: "web" }).suspend();  // -> the suspended instance
await ukc.instances.get({ name: "web" }).update({ memory_mb: 512 });

await ukc.metro("fra").instances
  .create({ image: "nginx:latest" })
  .wait({ state: "running", timeoutSeconds: 30 })
  .logs({ offset: -4096 });

await ukc.volumes.get({ name: "data" }).attach({ attach_to: { name: "web" }, at: "/data" });
```

Nothing is sent until a handle is awaited or chained onto, and each step runs at
most once however many times you await it. What that costs depends on the scope:

| Ref and scope                  | `get(ref).suspend()`                                              |
| ------------------------------ | ----------------------------------------------------------------- |
| `{ name, metro }`, any scope   | 1 request — the suspend. The ref says where.                       |
| `{ name }`, one metro in scope | 1 request — the scope says where.                                  |
| `{ name }`, many metros        | Locate first (one concurrent read per metro), then suspend where it lives — or throw `AmbiguousRefError` if several match. |

Handles also answer where they landed, and mutating steps return what that
endpoint reports (`suspend()` resolves to `{ uuid, name, state, previous_state }`,
not a full instance):

```ts
const web = ukc.instances.get({ name: "web" });
await web.where();   // "dal"
await web.resolve(); // { ref: { name: "web" }, metro: "dal", baseUrl: "..." }
```

Every idiomatic method is also available in non-chained form
(`ukc.instances.logs({ name: "web" }, { offset: -4096 })`), which is exactly
shorthand for `get(ref).logs(...)`.

## Updating a resource

The API models an update as a list of `{ prop, op, value }` triples, with `value`
typed `unknown`. That is the plumbing. Idiomatically you write a **patch object**
and the op is worked out for you — a value sets it, `null` removes it, and an
omitted (or `undefined`) property is left alone, following JSON Merge Patch:

```ts
await ukc.instances.get({ name: "web" }).update({ memory_mb: 512, vcpus: 2 });
await ukc.instances.get({ name: "web" }).update({ env: { LOG_LEVEL: "debug" } });
await ukc.instances.get({ name: "web" }).update({ autokill: null });   // remove it
await ukc.volumes.get({ name: "data" }).update({ size_mb: 2048 });
await ukc.services.get({ name: "web" }).update({ soft_limit: 5, hard_limit: 20 });
```

Every property is typed, so `memory_mb: "512"` and `tags: "prod"` no longer
compile. `image` takes the same string shorthand as `create`.

When `set` is not what you mean — merging into a property, or removing individual
members — stage the operations with `edit()` and send them as one request:

```ts
await ukc.instances.get({ name: "web" }).edit()
  .set({ memory_mb: 512 })
  .add({ env: { LOG_LEVEL: "debug" }, tags: ["prod"] })
  .del({ env: ["OLD_FLAG"], tags: ["staging"] })
  .apply();

// `null` in del() removes the property outright, not just some members.
await ukc.services.edit({ name: "web" }).del({ domains: null }).apply();
```

`apply()` returns a handle like any other operation, so chaining continues:

```ts
await ukc.metro("fra").instances
  .edit({ name: "web" })
  .set({ memory_mb: 1024 })
  .apply()
  .wait({ state: "running" });
```

Both forms are one request, and both are available with a ref instead of a handle
(`ukc.instances.update({ name: "web" }, { memory_mb: 512 })`,
`ukc.instances.edit({ name: "web" })`). The raw triples still work as an escape
hatch: `update({ name: "web" }, [{ prop: "memory_mb", op: "set", value: 512 }])`.

## Refs

Every operation on an existing resource takes a **ref**: either `{ name }` or
`{ uuid }`, never both. The API validates each identifier it is given, so a name
sent in the `uuid` filter fails with `Invalid uuid '<name>'` — the ref makes you
state which kind you hold, and only that field is sent.

```ts
await ukc.instances.get({ name: "web" });
await ukc.instances.get({ uuid: "550e8400-e29b-41d4-a716-446655440000" });

// A name belongs to a metro, so it can be qualified — see "Names across metros".
await ukc.instances.get({ name: "web", metro: "fra" });

// Bulk operations take one ref or an array of them.
await ukc.instances.stop([{ name: "web" }, { uuid: "550e8400-e29b-41d4-a716-446655440000" }]);
```

## Idiomatic methods

| Resource           | Methods                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `ukc.instances`    | `create`, `get`, `each`, `list`, `update`, `edit`, `delete`, `start`, `stop`, `suspend`, `wait`, `metrics`, `history`, `logs` |
| `ukc.volumes`      | `create`, `get`, `each`, `list`, `update`, `edit`, `delete`, `attach`, `detach`                  |
| `ukc.services`     | `create`, `get`, `each`, `list`, `update`, `edit`, `delete`                                      |
| `ukc.certificates` | `create`, `get`, `each`, `list`, `update`, `delete`                                             |
| `ukc.users`        | `quotas`, `quotasByUuid`                                                                       |

Handles add the per-resource operations: `refresh`, `start`, `stop`, `suspend`,
`delete`, `update`, `edit`, `wait`, `logs`, `metrics`, `history` on an instance;
`attach`, `detach`, `update`, `edit`, `delete` on a volume; `update`, `edit` and
`delete` on a service group.

Anything not listed — autoscale, the image registry, node information, the whole
control plane — is reachable raw via `ukc.api.platform.*` and
`ukc.api.controlplane.*`:

```ts
await ukc.api.platform.autoscale.getAutoscaleConfigurations({ uuid: ["sg1"] });
await ukc.api.platform.images.getImages({});
```

See [`examples/`](./examples) for complete programs.

## Errors

Any network failure or non-2xx response throws an `UnikraftCloudError`:

```ts
import { UnikraftCloudError } from "@unikraft/cloud";

try {
  await ukc.metro("fra").instances.get({ name: "does-not-exist" });
} catch (err) {
  if (err instanceof UnikraftCloudError) {
    console.error(err.kind, err.status, err.message, err.errors);
  }
}
```

`err.kind` is `"http"`, `"network"`, `"parse"`, or `"fanout"` (a multi-metro
operation that partly failed, or an unusable scope — see `MetroFanoutError`
above).

## Self-hosted and staging deployments

`metro` (and `UKC_METRO`) also accepts a full `http(s)://` base URL, which is
used verbatim instead of being expanded into `https://api.<metro>.unikraft.cloud`.
A trailing `/v1` is dropped, since every operation path already carries it:

```sh
export UKC_METRO=https://api.staging.example.internal
```

A named endpoint is the only endpoint there is: no metro discovery is attempted
and no hostnames are invented, whatever the scope says. Point the control plane
at a matching deployment with `controlPlaneUrl`:

```ts
const ukc = new UnikraftCloud({
  token,
  metro: "https://api.staging.example.internal",
  controlPlaneUrl: "https://controlplane.staging.example.internal",
});
```

## Runtime support

`fetch` is used from the global scope. On Node.js 18+ it is built in. For older
runtimes, or to customise transport, pass your own:

```ts
import { UnikraftCloud } from "@unikraft/cloud";
const ukc = new UnikraftCloud({ token, fetch: myFetch });
```

## Debugging with a proxy (MITM)

On Node, the client honours the standard proxy environment variables so you can
route traffic through a man-in-the-middle proxy such as
[mitmproxy](https://mitmproxy.org), Charles, or Proxyman without any code
change:

```sh
npm install undici                 # optional peer dependency, enables proxy support
export HTTPS_PROXY=http://127.0.0.1:8080
export NODE_EXTRA_CA_CERTS=~/.mitmproxy/mitmproxy-ca-cert.pem   # trust the proxy CA
node your-script.js
```

`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY` are all recognised, in
upper- or lower-case. Node's global `fetch` ignores these by itself, so the SDK
applies them via undici's `EnvHttpProxyAgent`, imported lazily only when a proxy
variable is set. If `undici` is not installed, requests proceed unproxied and a
one-time warning is logged.

Opt out per client with `new UnikraftCloud({ proxyFromEnv: false })`. Proxy
support is Node-only; browsers and Deno ignore these variables.

## Contributing

The plumbing layer is generated — see [CONTRIBUTING.md](./CONTRIBUTING.md) for
how to regenerate it and work on the SDK.

## License

BSD-3-Clause. See [LICENSE.md](./LICENSE.md).

[ukc]: https://unikraft.com
[openapi]: https://github.com/unikraft-cloud/openapi
[dashboard]: https://console.unikraft.cloud
