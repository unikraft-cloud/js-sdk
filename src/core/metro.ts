// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

import { stripTrailingSlashes } from "./url.js";

/**
 * A Unikraft Cloud metro (region) code, or a full `http(s)://` base URL for a
 * self-hosted or staging deployment. The known metros are enumerated for
 * convenience and autocompletion, but any string is accepted so new metros
 * work without an SDK upgrade.
 */
export type Metro =
  | "fra" // Frankfurt, DE
  | "dal" // Dallas, TX, USA
  | "sin" // Singapore
  | "was" // Washington, DC, USA
  | "sfo" // San Francisco, CA, USA
  // Allow any metro string while preserving literal autocompletion above.
  | (string & {});

/** The metros known at the time this SDK was published. */
export const KNOWN_METROS: readonly Metro[] = ["fra", "dal", "sin", "was", "sfo"];

/** The metro used when none is configured. */
export const DEFAULT_METRO: Metro = "fra";

/**
 * Which metros an operation covers: every metro the account can reach
 * (`"all"`), a single metro, or an explicit list.
 *
 * @example
 * ukc.instances.list();                        // the client's default scope
 * ukc.instances.list({ metros: "all" });       // fan out across every metro
 * ukc.instances.list({ metros: ["fra", "dal"] });
 */
export type MetroScope = "all" | Metro | ReadonlyArray<Metro>;

/** A metro paired with the platform API base URL that serves it. */
export interface MetroEndpoint {
  /** Metro code (e.g. `"fra"`), or the base URL itself for an explicit endpoint. */
  metro: Metro;
  /** Fully-qualified platform API base URL for this metro. */
  baseUrl: string;
}

/** Pair a metro with its base URL. */
export function metroEndpoint(metro: Metro): MetroEndpoint {
  return { metro, baseUrl: metroBaseUrl(metro) };
}

/** A resource annotated with the metro it lives in. */
export type WithMetro<T> = T & {
  /** The metro this resource was read from. */
  metro: Metro;
};

/** Tag a resource with its metro. */
export function withMetro<T extends object>(value: T, metro: Metro): WithMetro<T> {
  return { ...value, metro } as WithMetro<T>;
}

/**
 * Build the API base URL for a metro, e.g. `fra` ->
 * `https://api.fra.unikraft.cloud`.
 *
 * A value that is already an `http(s)://` URL is used verbatim (minus any
 * trailing slash), so `UKC_METRO` can point at a staging or self-hosted
 * deployment. Generated operation paths already carry the `/v1` prefix, so a
 * trailing `/v1` is dropped rather than duplicated into `/v1/v1/...`.
 *
 * @example
 * metroBaseUrl("fra"); // "https://api.fra.unikraft.cloud"
 * metroBaseUrl("https://api.staging.example.com/v1"); // "https://api.staging.example.com"
 */
export function metroBaseUrl(metro: Metro): string {
  if (/^https?:\/\//i.test(metro)) {
    return stripTrailingSlashes(metro).replace(/\/v1$/, "");
  }
  return `https://api.${metro}.unikraft.cloud`;
}

/**
 * The control-plane API base URL. Unlike the platform API, the control plane is
 * global (not metro-scoped).
 */
export const CONTROLPLANE_BASE_URL = "https://controlplane.unikraft.cloud";
