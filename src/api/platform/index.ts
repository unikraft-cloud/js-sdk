// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// The platform API's "plumbing" layer: the generated clients, plus a container
// that groups them behind one transport config. Everything here returns the
// response envelope exactly as the OpenAPI specification describes it.

import { AutoscaleApi } from "./autoscale.gen.js";
import { CertificatesApi } from "./certificates.gen.js";
import { ImagesApi } from "./images.gen.js";
import { InstancesApi } from "./instances.gen.js";
import { NodeApi } from "./node.gen.js";
import { ServiceGroupsApi } from "./service-groups.gen.js";
import { UsersApi } from "./users.gen.js";
import { VolumesApi } from "./volumes.gen.js";

import type { ApiClientConfig } from "../../core/http.js";

/**
 * Every platform API resource, raw. The platform API is metro-scoped: these
 * clients talk to the one metro their `baseUrl` names, and a single call can be
 * redirected with `{ baseUrl }`. Fanning out across metros is the idiomatic
 * layer's job ({@link UnikraftCloud}).
 *
 * @example
 * import { PlatformApi } from "@unikraft/cloud/api/platform";
 *
 * const api = new PlatformApi({
 *   baseUrl: "https://api.fra.unikraft.cloud",
 *   token: process.env.UKC_TOKEN,
 * });
 * const res = await api.instances.getInstances({ count: 10, details: true });
 * res.data?.instances;
 */
export class PlatformApi {
  /** Instances (microVMs). */
  readonly instances: InstancesApi;
  /** Persistent volumes. */
  readonly volumes: VolumesApi;
  /** Service groups (load-balanced networking). */
  readonly services: ServiceGroupsApi;
  /** TLS certificates. */
  readonly certificates: CertificatesApi;
  /** Autoscale configurations and policies. */
  readonly autoscale: AutoscaleApi;
  /** Image registry (metro-scoped view). */
  readonly images: ImagesApi;
  /** Users and quotas. */
  readonly users: UsersApi;
  /** Metro node information. */
  readonly node: NodeApi;

  constructor(config: ApiClientConfig) {
    this.instances = new InstancesApi(config);
    this.volumes = new VolumesApi(config);
    this.services = new ServiceGroupsApi(config);
    this.certificates = new CertificatesApi(config);
    this.autoscale = new AutoscaleApi(config);
    this.images = new ImagesApi(config);
    this.users = new UsersApi(config);
    this.node = new NodeApi(config);
  }
}

export * from "./index.gen.js";
