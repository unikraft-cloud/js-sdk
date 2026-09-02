// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// The raw ("plumbing") layer of every Unikraft Cloud API, in one place.
// Everything here mirrors the OpenAPI specification: operations are named after
// their `operationId`, and responses come back as the untouched envelope.
//
// The platform and control-plane APIs share one set of credentials and are
// grouped under {@link Api}. Plugin APIs are not: a plugin answers on a single
// instance's route, so its client is constructed per sandbox rather than per
// account.
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
export { SandboxPluginApi } from "./plugins/sandbox/index.js";

// Namespaced so the specifications' identically-named types (`models`,
// `ImagesApi`, `ResponseStatus`, ...) do not collide.
export * as platform from "./platform/index.js";
export * as controlplane from "./controlplane/index.js";
export * as sandbox from "./plugins/sandbox/index.js";
