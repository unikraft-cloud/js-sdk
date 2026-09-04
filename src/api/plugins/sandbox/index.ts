// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// The sandbox plugin API's "plumbing" layer: the generated clients, plus a
// container that groups them behind one transport config. Everything here
// returns the response envelope exactly as the OpenAPI specification describes
// it.

import { CommandsApi } from "./commands.gen.js";
import { FsApi } from "./fs.gen.js";

import type { ApiClientConfig } from "../../../core/http.js";

/**
 * Every sandbox plugin API resource, raw.
 *
 * Unlike the platform and control-plane APIs, this one is *instance*-scoped:
 * the plugin runs inside a single instance and answers on that instance's
 * plugin route, so `baseUrl` is the full plugin endpoint rather than a metro
 * root:
 *
 * ```
 * <metro base URL>/v1/instances/<uuid>/plugins/<plugin name>
 * ```
 *
 * The `<plugin name>` segment is whatever name the plugin was attached under
 * in the instance's `plugins` array — it is not necessarily `sandbox`.
 *
 * Creating the instance, attaching the plugin and deriving this URL is the
 * idiomatic layer's job; reach for this class only when you want the raw
 * envelopes against a sandbox you already have.
 *
 * @example
 * import { SandboxPluginApi } from "@unikraft/cloud/api/plugins/sandbox";
 *
 * const api = new SandboxPluginApi({
 *   baseUrl: `https://api.fra.unikraft.cloud/v1/instances/${uuid}/plugins/sandbox`,
 *   token: process.env.UKC_TOKEN,
 * });
 * const res = await api.commands.runCommand({ body: { command: "echo hi" } });
 * res.data?.uuid;
 */
export class SandboxPluginApi {
  /** Shell commands running inside the sandbox. */
  readonly commands: CommandsApi;
  /** The sandbox filesystem. */
  readonly fs: FsApi;

  constructor(config: ApiClientConfig) {
    this.commands = new CommandsApi(config);
    this.fs = new FsApi(config);
  }
}

export * from "./index.gen.js";
