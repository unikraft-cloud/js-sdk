// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// The raw ("plumbing") layer of both Unikraft Cloud APIs, in one place.
// Everything here mirrors the OpenAPI specification: operations are named after
// their `operationId`, and responses come back as the untouched envelope.
//
// The idiomatic ("porcelain") layer lives at the package root and is built on
// top of this.

import type { ApiClientConfig } from "../core/http.js";
import { ControlPlaneApi } from "./controlplane/index.js";
import { PlatformApi } from "./platform/index.js";

/**
 * Both raw API surfaces behind one set of credentials, as exposed by
 * `ukc.api`.
 *
 * @example
 * await ukc.api.platform.instances.getInstances({ count: 10 });
 * await ukc.api.controlplane.metros.listMetros();
 */
export class Api {
  /** The metro-scoped platform API. */
  readonly platform: PlatformApi;
  /** The global control-plane API. */
  readonly controlplane: ControlPlaneApi;

  constructor(platform: ApiClientConfig, controlPlane: ApiClientConfig) {
    this.platform = new PlatformApi(platform);
    this.controlplane = new ControlPlaneApi(controlPlane);
  }
}

export { ControlPlaneApi } from "./controlplane/index.js";
export { PlatformApi } from "./platform/index.js";

// Namespaced so the two specifications' identically-named types (`models`,
// `ImagesApi`, ...) do not collide.
export * as platform from "./platform/index.js";
export * as controlplane from "./controlplane/index.js";
