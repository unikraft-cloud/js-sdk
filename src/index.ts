// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

import { Api } from "./api/index.js";
import { readEnv } from "./core/env.js";
import type { ApiClientConfig, FetchLike } from "./core/http.js";
import {
  CONTROLPLANE_BASE_URL,
  DEFAULT_METRO,
  type Metro,
  type MetroEndpoint,
  type MetroScope,
  metroBaseUrl,
} from "./core/metro.js";
import { Session } from "./core/session.js";
import { Certificates } from "./resources/certificates.js";
import { Instances } from "./resources/instances.js";
import { ServiceGroups } from "./resources/service-groups.js";
import { Users } from "./resources/users.js";
import { Volumes } from "./resources/volumes.js";

/** Default User-Agent sent with every request. */
const USER_AGENT = "@unikraft/cloud";

/** Configuration for the top-level {@link UnikraftCloud} client. */
export interface UnikraftCloudConfig {
  /**
   * Bearer token used for authentication. Falls back to the `UKC_TOKEN`
   * environment variables when omitted.
   */
  token?: string;
  /**
   * Pin the client to a single metro, e.g. `"fra"`, or to a full `http(s)://`
   * base URL for a staging or self-hosted deployment (used verbatim). Falls back
   * to the `UKC_METRO` environment variable. When omitted, operations cover
   * **every** metro the account can reach.
   */
  metro?: Metro;
  /**
   * The metros operations cover by default: `"all"` (the default), one metro, or
   * a list. Takes precedence over {@link UnikraftCloudConfig.metro}, which only
   * remains the target for operations that must pick a single metro.
   */
  metros?: MetroScope;
  /** Explicit platform API base URL; overrides {@link UnikraftCloudConfig.metro}. */
  baseUrl?: string;
  /** Override the control-plane API base URL. */
  controlPlaneUrl?: string;
  /** Custom `fetch` implementation (defaults to the global `fetch`). */
  fetch?: FetchLike;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /** Override the default User-Agent. */
  userAgent?: string;
  /**
   * Honour the `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` environment variables (any
   * case) on Node, routing requests through the proxy (requires the optional
   * `undici` dependency). Defaults to `true`; set `false` to opt out.
   */
  proxyFromEnv?: boolean;
}

/**
 * The idiomatic resource clients for one metro scope. Every operation on these
 * covers the scope: reads fan out and are merged, and each result carries the
 * `metro` it came from.
 */
export class Scope {
  /** Instances (microVMs). */
  readonly instances: Instances;
  /** Persistent volumes. */
  readonly volumes: Volumes;
  /** Service groups (load-balanced networking). */
  readonly services: ServiceGroups;
  /** TLS certificates. */
  readonly certificates: Certificates;
  /** Users and quotas. */
  readonly users: Users;
  /** Which metros these clients cover. */
  readonly scope: MetroScope;
  /**
   * The transport and metro knowledge these clients share: one set of
   * credentials, one metro discovery. Pass it on rather than rebuilding it —
   * `Sandbox.create({ client })` borrows exactly this.
   */
  readonly session: Session;

  constructor(session: Session, scope: MetroScope) {
    this.session = session;
    this.scope = scope;
    this.instances = new Instances(session, scope);
    this.volumes = new Volumes(session, scope);
    this.services = new ServiceGroups(session, scope);
    this.certificates = new Certificates(session, scope);
    this.users = new Users(session, scope);
  }
}

/**
 * The resource clients for exactly one metro, as returned by
 * {@link UnikraftCloud.metro}. Because the metro is known, single-resource
 * operations need no lookup: `get(ref).suspend()` is one request.
 */
export class MetroClient extends Scope {
  /** The metro these clients are pinned to. */
  readonly endpoint: MetroEndpoint;
  /** The raw API surfaces, with the platform API pinned to this metro. */
  readonly api: Api;

  constructor(session: Session, endpoint: MetroEndpoint) {
    super(session, endpoint.metro);
    this.endpoint = endpoint;
    this.api = new Api({ ...session.platform, baseUrl: endpoint.baseUrl }, session.controlPlane);
  }
}

/** Build the shared session (transport + metro discovery) from user config. */
function buildSession(config: UnikraftCloudConfig): Session {
  const envMetro = readEnv("UKC_METRO");
  const metro = config.metro ?? envMetro;
  const token = config.token ?? readEnv("UKC_TOKEN");
  const shared = {
    token,
    fetch: config.fetch,
    headers: config.headers,
    userAgent: config.userAgent ?? USER_AGENT,
    proxyFromEnv: config.proxyFromEnv,
  };

  // A named base URL (explicitly, or as the `metro`) is the only endpoint there
  // is: there is nothing to discover, and no hostnames to invent.
  const explicitUrl =
    config.baseUrl ?? (metro !== undefined && /^https?:\/\//i.test(metro) ? metro : undefined);
  const defaultMetro = metro ?? DEFAULT_METRO;
  const baseUrl = explicitUrl ? metroBaseUrl(explicitUrl) : metroBaseUrl(defaultMetro);

  const platform: ApiClientConfig = { ...shared, baseUrl };
  const controlPlane: ApiClientConfig = {
    ...shared,
    baseUrl: config.controlPlaneUrl ?? CONTROLPLANE_BASE_URL,
  };

  return new Session({
    platform,
    controlPlane,
    defaultMetro,
    pinned: explicitUrl ? { metro: baseUrl, baseUrl } : undefined,
  });
}

/** Work out the default scope: an explicit list, a pinned metro, or every metro. */
function defaultScope(config: UnikraftCloudConfig): MetroScope {
  if (config.metros !== undefined) return config.metros;
  const metro = config.metro ?? readEnv("UKC_METRO");
  return metro ?? "all";
}

/**
 * The Unikraft Cloud SDK entry point.
 *
 * By default the client is account-wide: reads cover every metro the account can
 * reach and are merged into one stream, with each result tagged by metro. Narrow
 * that whenever you already know where a resource lives — with
 * {@link UnikraftCloud.metro}, `{ metros }` on a call, or `metro`/`metros` in the
 * constructor — which also skips metro discovery.
 *
 * The raw, spec-shaped API stays available on {@link UnikraftCloud.api} and from
 * `@unikraft/cloud/api/platform` and `@unikraft/cloud/api/controlplane`.
 *
 * @example
 * ```ts
 * import { UnikraftCloud } from "@unikraft/cloud";
 *
 * const ukc = new UnikraftCloud({ token: process.env.UKC_TOKEN });
 *
 * // Every metro, merged as the pages arrive.
 * for await (const inst of ukc.instances.list({ details: true })) {
 *   console.log(inst.metro, inst.name, inst.state);
 * }
 *
 * // One metro, one request per operation.
 * await ukc.metro("fra").instances.get({ name: "web" }).suspend();
 * ```
 */
export class UnikraftCloud extends Scope {
  /**
   * The raw ("plumbing") API surfaces: `api.platform` (metro-scoped, pointing at
   * the default metro unless a call passes `baseUrl`) and `api.controlplane`.
   */
  readonly api: Api;

  #metros = new Map<string, MetroClient>();

  constructor(config: UnikraftCloudConfig = {}) {
    const session = buildSession(config);
    super(session, defaultScope(config));
    this.api = new Api(session.platform, session.controlPlane);
  }

  /**
   * The resource clients for a single metro. Cached, so repeated calls share one
   * set of clients.
   *
   * @example
   * const fra = ukc.metro("fra");
   * await fra.instances.create({ image: "nginx:latest" });
   */
  metro(metro: Metro): MetroClient {
    const endpoint = this.session.pinned ?? { metro, baseUrl: metroBaseUrl(metro) };
    const cached = this.#metros.get(endpoint.baseUrl);
    if (cached) return cached;
    const client = new MetroClient(this.session, endpoint);
    this.#metros.set(endpoint.baseUrl, client);
    return client;
  }

  /**
   * The resource clients for several metros, or for every metro (`"all"`).
   *
   * @example
   * for await (const inst of ukc.metros(["fra", "dal"]).instances.list()) { ... }
   */
  metros(scope: MetroScope): Scope {
    return new Scope(this.session, scope);
  }

  /**
   * Every metro this account can reach, as reported by the control plane and
   * cached for the client's lifetime.
   *
   * @example
   * for (const { metro, baseUrl } of await ukc.availableMetros()) {
   *   console.log(metro, baseUrl);
   * }
   */
  availableMetros(): Promise<MetroEndpoint[]> {
    return this.session.discover();
  }
}

export default UnikraftCloud;

// Raw ("plumbing") API layer.
export { Api, ControlPlaneApi, PlatformApi } from "./api/index.js";

// Error type and transport primitives.
export {
  ApiClient,
  UnikraftCloudError,
  type ApiClientConfig,
  type ApiResponse,
  type CallOptions,
  type FetchLike,
  type ResponseError,
  type UnikraftCloudErrorKind,
} from "./core/http.js";

// Metros and scopes.
export {
  type Metro,
  type MetroEndpoint,
  type MetroScope,
  type WithMetro,
  CONTROLPLANE_BASE_URL,
  DEFAULT_METRO,
  KNOWN_METROS,
  metroBaseUrl,
  metroEndpoint,
  withMetro,
} from "./core/metro.js";

// Multi-metro fan-out.
export {
  AmbiguousRefError,
  MetroFanoutError,
  type MetroFailure,
  type MetroOutcome,
  fanout,
  fanoutSettled,
} from "./core/fanout.js";

// Chainable resource handles.
export { HandleSet } from "./core/handle-set.js";
export {
  ResourceHandle,
  type HandleSteps,
  type Located,
  type MetroTarget,
} from "./core/handle.js";

// Resource plumbing shared by the idiomatic clients.
export { Resource, type MetroGroup, type ScopeOptions } from "./core/resource.js";
export { Session, type SessionConfig } from "./core/session.js";

// Updating resources: patch objects and the staged editor.
export {
  ResourceEditor,
  type DeletePatch,
  type Patch,
  type PatchItem,
  type PatchOp,
  toPatchItems,
} from "./core/patch.js";

// Pagination + response helpers.
export { collect, paginate } from "./core/pagination.js";
export {
  type Envelope,
  type Ref,
  type WireRef,
  describeRef,
  orAbsent,
  toQuery,
  toRefs,
  unwrap,
  unwrapFirst,
  unwrapList,
  wireRef,
} from "./core/response.js";

// Idiomatic resource clients (also reachable via the `UnikraftCloud` instance).
export {
  Instances,
  InstanceHandle,
  InstanceSet,
  type Instance,
  type InstanceEditor,
  type InstanceMembers,
  type InstanceProperties,
  type InstanceUpdate,
  type ListInstancesOptions,
  type LogsOptions,
  type WaitOptions,
  type InstanceRef,
  type InstancePatch,
  type CreateInstanceInput,
  type UpdatedInstance,
} from "./resources/instances.js";
export {
  Volumes,
  VolumeHandle,
  VolumeSet,
  type Volume,
  type VolumeEditor,
  type VolumeMembers,
  type VolumeProperties,
  type VolumeUpdate,
  type ListVolumesOptions,
  type VolumeRef,
  type VolumeAttach,
  type VolumeDetach,
  type VolumePatch,
  type UpdatedVolume,
} from "./resources/volumes.js";
export {
  ServiceGroups,
  ServiceGroupHandle,
  ServiceGroupSet,
  type ServiceGroup,
  type ServiceGroupEditor,
  type ServiceGroupMembers,
  type ServiceGroupProperties,
  type ServiceGroupUpdate,
  type ListServiceGroupsOptions,
  type ServiceGroupRef,
  type ServiceGroupPatch,
  type UpdatedServiceGroup,
} from "./resources/service-groups.js";
export {
  Certificates,
  CertificateHandle,
  CertificateSet,
  type Certificate,
  type ListCertificatesOptions,
  type CertificateRef,
  type CertificateUpdate,
} from "./resources/certificates.js";
export { pluginBaseUrl } from "./core/plugin.js";
export { Users, type Quota } from "./resources/users.js";

// Wire types, namespaced per API surface.
export type * as platform from "./api/platform/models.gen.js";
export type * as controlplane from "./api/controlplane/models.gen.js";
