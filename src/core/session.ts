// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// The transport and metro knowledge shared by every resource client: one set of
// credentials, one memoised metro discovery, and the rules for turning a metro
// scope into concrete endpoints.

import { MetrosApi } from "../api/controlplane/metros.gen.js";
import { type ApiClientConfig, UnikraftCloudError } from "./http.js";
import {
  type Metro,
  type MetroEndpoint,
  type MetroScope,
  metroBaseUrl,
  metroEndpoint,
} from "./metro.js";
import { unwrapList } from "./response.js";

/** How a {@link Session} was configured. */
export interface SessionConfig {
  /** Transport config for the platform API; its `baseUrl` is the default metro. */
  platform: ApiClientConfig;
  /** Transport config for the global control-plane API. */
  controlPlane: ApiClientConfig;
  /** The metro used for operations that must pick exactly one (e.g. `create`). */
  defaultMetro: Metro;
  /**
   * Set when the caller named an explicit endpoint (`baseUrl`, or a `metro`
   * that is already a URL). Every scope then resolves to just that endpoint:
   * there is nothing to discover, and fanning out would invent hostnames the
   * caller never mentioned.
   */
  pinned?: MetroEndpoint;
}

/**
 * Shared state behind one {@link UnikraftCloud} client: credentials, the
 * control-plane client used to discover metros, and the cache of that
 * discovery. Scoped clients (`ukc.metro("fra")`) reuse the same session, so
 * discovery and connections are shared rather than duplicated.
 */
export class Session {
  /** Platform transport config; `baseUrl` points at the default metro. */
  readonly platform: ApiClientConfig;
  /** Control-plane transport config (the control plane is global). */
  readonly controlPlane: ApiClientConfig;
  /** Endpoint used when an operation needs exactly one metro. */
  readonly defaultEndpoint: MetroEndpoint;
  /** The single endpoint every scope collapses to, when one was named. */
  readonly pinned?: MetroEndpoint;

  #metros?: MetrosApi;
  #discovery?: Promise<MetroEndpoint[]>;
  /** The endpoints discovery reported, by metro code. */
  readonly #discovered = new Map<Metro, MetroEndpoint>();

  constructor(config: SessionConfig) {
    this.platform = config.platform;
    this.controlPlane = config.controlPlane;
    this.pinned = config.pinned;
    this.defaultEndpoint =
      config.pinned ??
      ({ metro: config.defaultMetro, baseUrl: config.platform.baseUrl } as MetroEndpoint);
  }

  /**
   * Every metro this account can reach, asked of the control plane once and
   * cached for the client's lifetime. A failed discovery is not cached, so a
   * transient control-plane outage does not poison the client.
   */
  discover(): Promise<MetroEndpoint[]> {
    if (this.pinned) return Promise.resolve([this.pinned]);
    if (this.#discovery) return this.#discovery;

    const discovery = this.#listMetros();
    this.#discovery = discovery;
    discovery.catch(() => {
      if (this.#discovery === discovery) this.#discovery = undefined;
    });
    return discovery;
  }

  async #listMetros(): Promise<MetroEndpoint[]> {
    this.#metros ??= new MetrosApi(this.controlPlane);

    let metros: Array<{ endpoint?: string; iata_code?: string; name?: string }>;
    try {
      metros = unwrapList(await this.#metros.listMetros(), "metros");
    } catch (cause) {
      throw new UnikraftCloudError(
        'Could not discover the available metros from the control plane. Name the metros you want (`new UnikraftCloud({ metro: "fra" })`, `ukc.metro("fra")`, or `{ metros: [...] }`) to skip discovery.',
        { kind: "fanout", cause },
      );
    }

    const endpoints: MetroEndpoint[] = [];
    for (const metro of metros) {
      // Prefer the IATA code as the identity users type; fall back to `name`.
      const code = metro.iata_code || metro.name;
      if (!code) continue;
      // The control plane reports each metro's own endpoint; trust it over a
      // URL built from the code, so new or relocated metros just work.
      endpoints.push({
        metro: code,
        baseUrl: metroBaseUrl(metro.endpoint || code),
      });
    }

    if (endpoints.length === 0) {
      throw new UnikraftCloudError(
        "The control plane reported no metros for this account, so there is nothing to query.",
        { kind: "fanout" },
      );
    }
    for (const endpoint of endpoints) this.#discovered.set(endpoint.metro, endpoint);
    return endpoints;
  }

  /**
   * The endpoint for a metro code, from what the session already knows. Sends
   * no request.
   *
   * A resource carries its metro code, not the URL it was read through. The two
   * differ when the client is pinned to a URL, and when the control plane
   * reports an endpoint that the code does not build (staging, for example).
   * Falls back to the URL derived from the code.
   */
  endpointFor(metro: Metro): MetroEndpoint {
    if (this.pinned) return this.pinned;
    return this.#discovered.get(metro) ?? metroEndpoint(metro);
  }

  /**
   * Turn a scope into the endpoints to call. An explicit scope never triggers
   * discovery — naming metros is also how you avoid the extra request.
   */
  async resolve(scope: MetroScope): Promise<MetroEndpoint[]> {
    if (this.pinned) return [this.pinned];
    if (scope === "all") return this.discover();

    const codes = typeof scope === "string" ? [scope] : [...scope];
    if (codes.length === 0) {
      throw new UnikraftCloudError(
        'An empty metro scope selects no metros; pass `"all"` or at least one metro.',
        { kind: "fanout" },
      );
    }
    return codes.map(metroEndpoint);
  }

  /**
   * Resolve a scope that must name exactly one metro (creating a resource, or a
   * bulk operation on refs that were never located). Falls back to the default
   * metro when the scope is `"all"`, since "create this instance in all metros"
   * is not a thing a caller can mean.
   */
  async resolveOne(scope: MetroScope, operation: string): Promise<MetroEndpoint> {
    if (this.pinned) return this.pinned;
    if (scope === "all") return this.defaultEndpoint;

    const endpoints = await this.resolve(scope);
    if (endpoints.length === 1) return endpoints[0] as MetroEndpoint;
    throw new UnikraftCloudError(
      `${operation} targets a single metro, but the current scope spans ${endpoints.length} (${endpoints
        .map((e) => e.metro)
        .join(
          ", ",
        )}). Pick one with \`ukc.metro("${endpoints[0]?.metro}")\` or \`{ metros: "${endpoints[0]?.metro}" }\`.`,
      { kind: "fanout" },
    );
  }
}
