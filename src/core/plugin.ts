// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// Where a plugin's API lives. This is the platform's route layout, not an
// abstraction over plugins: a plugin is reached through a route under the
// instance that runs it, and the porcelain for each one stays its own — a
// `Sandbox` is a sandbox, not an instance of some generic `Plugin`.

/**
 * The plugin's endpoint under an instance.
 *
 * Built here rather than read from the specification: `sandbox/api.tsp`
 * declares a server URL that both omits `/v1` (which 404s) and hardcodes
 * `sandbox` as the segment, where the segment is really whatever name the
 * plugin was attached under.
 *
 * @example
 * pluginBaseUrl("https://api.fra.unikraft.cloud", uuid, "sandbox");
 * // "https://api.fra.unikraft.cloud/v1/instances/<uuid>/plugins/sandbox"
 */
export function pluginBaseUrl(metroBase: string, uuid: string, pluginName: string): string {
  return `${metroBase.replace(/\/+$/, "")}/v1/instances/${uuid}/plugins/${pluginName}`;
}
