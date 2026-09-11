// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// The defaults every sandbox call falls back to, and the plumbing between a
// caller's options and the two APIs underneath: what a plugin call may carry,
// what a byte range looks like on the wire, and which options belong to a
// client rather than to a call.

import type * as models from "../../api/platform/models.gen.js";
import type * as sandboxModels from "../../api/plugins/sandbox/models.gen.js";
import { toBase64 } from "../../core/base64.js";
import { type CallOptions, UnikraftCloudError } from "../../core/http.js";
import type { Instance } from "../instances.js";
import type {
  ConnectSandboxOptions,
  CreateSandboxOptions,
  SandboxCallOptions,
  SandboxRequestOptions,
} from "./types.js";

/** The plugin name, and so the URL segment, used when the caller names none. */
export const DEFAULT_PLUGIN_NAME = "sandbox";

/** The prebuilt sandbox plugin ROM used when the caller names none. */
export const DEFAULT_PLUGIN_ROM = "plugins/sandbox:latest";

/**
 * The instance image a sandbox boots when the caller names none. A sandbox
 * runs whatever command it is handed, so its image only has to carry a shell
 * and a main process that stays alive. Any replacement must do both.
 */
export const DEFAULT_IMAGE = "debian-slim:latest";

/**
 * How long a stopped sandbox is kept before the platform deletes it, in
 * milliseconds. `autokill` measures time spent *stopped*, so a running sandbox
 * is untouched.
 */
export const DEFAULT_AUTOKILL_MS = 300_000;

/** How long `create` waits for the virtual machine to run, in seconds. */
export const DEFAULT_BOOT_TIMEOUT_S = 30;

/**
 * How much memory a sandbox gets when the caller names none, in megabytes: 2
 * GiB. A sandbox runs whatever command it is given, from a compiler to a test
 * suite, so it is sized for that rather than for one small service.
 */
export const DEFAULT_MEMORY_MB = 2048;

export const MISSING_TOKEN =
  "The UKC_TOKEN environment variable is missing or empty; either set it, or pass a token " +
  "explicitly: Sandbox.create({ image }, { token }), or use a client: " +
  'new UnikraftCloud({ token }).metro("fra").sandboxes.create({ image }).';

/** The encoding and payload the filesystem API wants for a caller's data. */
export function encodeFileData(data: string | Uint8Array): {
  encoding: sandboxModels.FileEncoding;
  data: string;
} {
  return typeof data === "string"
    ? { encoding: "utf-8", data }
    : { encoding: "base64", data: toBase64(data) };
}

/**
 * The `plugins` array to create with: the caller's, plus the sandbox plugin. An
 * entry already named `pluginName` is the sandbox plugin, so it is left as
 * written and keeps its `config`. Passing `rom` as well names two ROMs for one
 * plugin, which is refused rather than settled by precedence.
 */
export function withSandboxPlugin(
  plugins: models.CreateInstanceRequestPlugin[] | undefined,
  pluginName: string,
  rom?: string | models.ImageSpec,
): models.CreateInstanceRequestPlugin[] {
  const attached = plugins ?? [];
  const own = attached.find((plugin) => plugin.name === pluginName);
  if (own === undefined) {
    return [{ name: pluginName, rom: rom ?? DEFAULT_PLUGIN_ROM }, ...attached];
  }
  if (rom !== undefined) {
    throw new UnikraftCloudError(
      `The spec attaches a plugin named "${pluginName}" in \`plugins\` and also passes \`rom\`, so there are two ROMs for one plugin. Keep the \`plugins\` entry, which can also carry \`config\`, and drop \`rom\`.`,
      { kind: "config" },
    );
  }
  return attached;
}

/**
 * The `stop_reason` bits that only a running instance can set: [A]pp (bit 1)
 * for an application that exited, [K]ernel (bit 0) for a kernel that did. See
 * `Instance.stop_reason` for the whole bitmask.
 */
const STOP_REASON_RAN = 0b00011;

/**
 * Whether anything ever ran inside an instance. Three independent witnesses,
 * because each is optional on the wire: a start counter, a start timestamp, and
 * a stop reason that only a started instance can report.
 *
 * An instance whose image or plugin ROM could not be pulled has none of them.
 */
export function started(instance: Instance): boolean {
  return (
    (instance.start_count ?? 0) > 0 ||
    instance.started_at !== undefined ||
    ((instance.stop_reason ?? 0) & STOP_REASON_RAN) !== 0
  );
}

/**
 * Build the `Range` header for a byte range of a log stream.
 *
 * @example
 * rangeHeader(-4096);    // "bytes=-4096", the last 4 KiB
 * rangeHeader(0, 1024);  // "bytes=0-1023"
 */
export function rangeHeader(offset?: number, limit?: number): string | undefined {
  if (offset === undefined && limit === undefined) return undefined;
  if (limit !== undefined && limit <= 0) {
    throw new UnikraftCloudError(
      `A \`limit\` of ${limit} asks for no bytes at all; omit it to read to the end of the stream.`,
      { kind: "config" },
    );
  }
  const start = offset ?? 0;
  if (start < 0) {
    if (limit !== undefined) {
      throw new UnikraftCloudError(
        "A negative `offset` already names the last bytes of the stream, so it cannot be combined with `limit`.",
        { kind: "config" },
      );
    }
    return `bytes=${start}`;
  }
  return `bytes=${start}-${limit === undefined ? "" : start + limit - 1}`;
}

/**
 * Keep only the options a plugin call may receive. `baseUrl` is dropped: a
 * plugin call's base URL is the plugin's own endpoint, so a metro root there
 * would send `/commands` to the platform API. Reach another deployment with
 * `new UnikraftCloud({ baseUrl })`, which the sandbox derives its endpoint from.
 */
export function callOptions(opts: SandboxRequestOptions): CallOptions {
  const { signal, headers } = opts;
  return {
    ...(signal === undefined ? {} : { signal }),
    ...(headers === undefined ? {} : { headers }),
  };
}

/**
 * The options that name a client rather than a call: credentials, transport,
 * and which endpoint to talk to. Computed as the difference between the two
 * doors, so a new key on {@link UnikraftCloudConfig} lands here on its own.
 *
 * `headers` and `signal` are not among them, being per-call options as well.
 */
type ClientOnlyOption = keyof Omit<SandboxCallOptions, keyof CreateSandboxOptions>;

/**
 * The keys {@link assertNoClientConfig} refuses. A record rather than a list,
 * so `satisfies` checks both directions: an unlisted client option fails to
 * compile here, and a per-call option cannot be listed by mistake.
 *
 * `metro` and `metros` belong here too. They read as "where the sandbox goes",
 * but the metro of a sandbox is the metro of the client it is reached through:
 * `Sandboxes` hangs off one metro client, so an option naming another can only
 * contradict it.
 */
const CLIENT_ONLY_OPTIONS = {
  client: true,
  token: true,
  metro: true,
  metros: true,
  baseUrl: true,
  controlPlaneUrl: true,
  fetch: true,
  userAgent: true,
  proxyFromEnv: true,
} as const satisfies Record<ClientOnlyOption, true>;

const CLIENT_ONLY_KEYS = Object.keys(CLIENT_ONLY_OPTIONS) as ClientOnlyOption[];

/** Join items as prose: "a and b", "a, b, or c". */
function prose(items: string[], conjunction: "and" | "or"): string {
  if (items.length <= 1) return items.join("");
  const last = items[items.length - 1];
  const rest = items.slice(0, -1);
  return `${rest.join(", ")}${rest.length > 1 ? "," : ""} ${conjunction} ${last}`;
}

/**
 * Refuse options that would be silently ignored, the client they configure
 * already existing. The types of these doors exclude them, so this catches the
 * callers a type cannot: JavaScript, and an object widened along the way.
 *
 * @example
 * // Throws: the client was built with a different token, which wins.
 * const client = new UnikraftCloud({ token: OTHER_TOKEN });
 * await client.metro("fra").sandboxes.create({ image: "..." }, { token: MY_TOKEN });
 */
export function assertNoClientConfig(opts: object, door: string): void {
  const record = opts as Record<string, unknown>;
  const named = CLIENT_ONLY_KEYS.filter((key) => record[key] !== undefined);
  if (named.length === 0) return;
  const keys = prose(
    named.map((key) => `\`${key}\``),
    "and",
  );
  const verb = named.length === 1 ? "would" : "would each";

  // Each key has its own remedy: a borrowed client is a different door, a metro
  // is chosen one step earlier, and the rest are configured when a client is built.
  const remedies: string[] = [];
  if (named.includes("client")) {
    remedies.push("run the call through that client's own `sandboxes` instead");
  }
  const config = named.filter((key) => key !== "client" && key !== "metro" && key !== "metros");
  if (config.length > 0) {
    remedies.push(
      `set ${config.length === 1 ? "it" : "them"} when the client is built (\`new UnikraftCloud({ ${config.join(", ")} })\`)`,
    );
  }
  if (named.includes("metro") || named.includes("metros")) {
    // Echo the metro that was asked for, so the remedy is the call to write.
    // `metros` also accepts a list and `"all"`, which no single metro names.
    const wanted = record.metros ?? record.metro;
    const one = typeof wanted === "string" && wanted !== "all" ? wanted : "fra";
    remedies.push(`pick the metro one step earlier (\`ukc.metro("${one}").sandboxes\`)`);
  }
  remedies.push(
    "create the sandbox through `Sandbox.create(spec, opts)`, which builds a client from these options for you",
  );

  throw new UnikraftCloudError(
    `${door} runs through a client that already exists, so ${keys} ${verb} be ignored. To fix it, ${prose(remedies, "or")}.`,
    { kind: "config" },
  );
}

/** Drop the keys {@link assertNoClientConfig} rejects, once they are spent. */
export function withoutClientConfig<T extends SandboxCallOptions | ConnectSandboxOptions>(
  opts: T,
): Omit<T, ClientOnlyOption> {
  const rest = { ...opts } as Record<string, unknown>;
  for (const key of CLIENT_ONLY_KEYS) delete rest[key];
  return rest as Omit<T, ClientOnlyOption>;
}
