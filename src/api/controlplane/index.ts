// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// The control-plane API's "plumbing" layer. The control plane is global rather
// than metro-scoped: account, metro, image and self-hosted node management.

import { AuthApi } from "./auth.gen.js";
import { ImagesApi } from "./images.gen.js";
import { MetrosApi } from "./metros.gen.js";
import { NodeActivationServiceApi } from "./node-activation-service.gen.js";
import { NodeServiceApi } from "./node-service.gen.js";

import type { ApiClientConfig } from "../../core/http.js";

/**
 * Every control-plane API resource, raw.
 *
 * @example
 * import { ControlPlaneApi } from "@unikraft/cloud/api/controlplane";
 *
 * const api = new ControlPlaneApi({
 *   baseUrl: "https://controlplane.unikraft.cloud",
 *   token: process.env.UKC_TOKEN,
 * });
 * for (const metro of (await api.metros.listMetros()).data?.metros ?? []) {
 *   console.log(metro.iata_code, metro.endpoint);
 * }
 */
export class ControlPlaneApi {
  /** Authentication and token introspection. */
  readonly auth: AuthApi;
  /** Control-plane image registry. */
  readonly images: ImagesApi;
  /** Metro (region) discovery. */
  readonly metros: MetrosApi;
  /** Self-hosted node management. */
  readonly nodes: NodeServiceApi;
  /** Node activation. */
  readonly nodeActivation: NodeActivationServiceApi;

  constructor(config: ApiClientConfig) {
    this.auth = new AuthApi(config);
    this.images = new ImagesApi(config);
    this.metros = new MetrosApi(config);
    this.nodes = new NodeServiceApi(config);
    this.nodeActivation = new NodeActivationServiceApi(config);
  }
}

export * from "./index.gen.js";
