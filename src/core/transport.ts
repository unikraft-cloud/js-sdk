// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

import {
  createDirectSender,
  type DirectModules,
  type DirectOptions,
  type DirectSender,
} from "./h2.js";
import { createWorkerSender } from "./h2-worker.js";
import type { FetchLike } from "./http.js";

/** Opaque undici `Dispatcher` handle. */
export interface Dispatcher {
  dispatch(...args: never[]): boolean;
}

/**
 * What carries the requests that the global `fetch` does not carry. At most
 * one part is present: a proxy from the environment turns the direct path off.
 */
export interface Transport {
  /**
   * undici's `fetch` and a dispatcher that reads the proxy variables. The
   * two come from the SAME undici module. A dispatcher must only be used with
   * its own version's `fetch`: mixing a standalone-undici dispatcher into
   * Node's bundled `fetch` fails with `UND_ERR_INVALID_ARG: invalid
   * onRequestStart method`.
   */
  proxy?: { fetch: FetchLike; dispatcher: Dispatcher };
  /** The direct HTTP/2 path. Present only with `http2Direct`, on Node, and with no proxy. */
  direct?: DirectSender;
}

export interface TransportOptions {
  proxyFromEnv: boolean;
  /** Send the requests that the SDK reads whole over one `node:http2` session per origin. */
  http2Direct?: boolean;
  /** Run the session of `http2Direct` in a worker thread. */
  http2Worker?: boolean;
}

/** The boundaries of {@link createTransport}, which a test can replace. */
export interface TransportDeps {
  /** Loads the `undici` module. Defaults to `import("undici")`. */
  importUndici?: () => Promise<unknown>;
  /** Resolves a host on a cache miss. Defaults to `dns.promises.lookup`. */
  resolve?: Resolver;
  /** The timeouts of the direct HTTP/2 path. Defaults to the values in `h2.ts`. */
  direct?: Omit<DirectOptions, "cache">;
}

/** One address of a host, as `dns.lookup` reports it. */
export interface LookupAddress {
  address: string;
  family: number;
}

/** The options that `net.connect` gives to its `lookup` function. */
export interface LookupOptions {
  family?: number;
  hints?: number;
  all?: boolean;
}

/** The `lookup` function that `net.connect` accepts. */
export type LookupFunction = (
  hostname: string,
  options: LookupOptions,
  callback: (error: Error | null, address?: string | LookupAddress[], family?: number) => void,
) => void;

/** Resolves every address of a host, as `dns.promises.lookup` with `all: true` does. */
export type Resolver = (
  hostname: string,
  options: LookupOptions & { all: true },
) => Promise<LookupAddress[]>;

export interface CachedLookup {
  lookup: LookupFunction;
  /** Drops the answers for a host, so that its next connection resolves it again. */
  forget(hostname: string): void;
  /** True when the cache holds an answer for a host that has not expired. */
  fresh(hostname: string): boolean;
}

/** The parts of the `undici` module that this transport uses. */
interface Undici {
  fetch?: FetchLike;
  EnvHttpProxyAgent?: new () => Dispatcher;
}

// `getaddrinfo` does not report the time to live of a DNS record, so the
// cache keeps every answer for the same fixed time.
const DNS_TTL_MS = 5 * 60 * 1000;

const PROXY_ENV_VARS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
];

let warnedProxy = false;

/** Emit a one-time warning explaining why a set proxy env var isn't applied. */
function warnProxy(reason: string, cause?: unknown): void {
  if (warnedProxy) return;
  warnedProxy = true;
  const detail = cause ? ` (${String(cause)})` : "";
  console.warn(
    `[@unikraft/cloud] A proxy environment variable is set but requests will not be proxied: ${reason}${detail}`,
  );
}

// Deno also sets `process.versions.node`, but on Deno the SDK uses the `fetch`
// of Deno, as the README says.
function isNode(): boolean {
  return (
    typeof process !== "undefined" &&
    typeof process.versions?.node === "string" &&
    !("Deno" in globalThis)
  );
}

// Bun sets `process.versions.node` too, but its `node:http2` client is not
// the one that the direct path is built and tested on.
function isBun(): boolean {
  return typeof process !== "undefined" && typeof process.versions?.bun === "string";
}

/** True when any HTTP proxy environment variable is set. */
function hasProxyEnv(): boolean {
  if (typeof process === "undefined" || !process.env) return false;
  return PROXY_ENV_VARS.some((name) => {
    const v = process.env[name];
    return typeof v === "string" && v.length > 0;
  });
}

// A non-literal specifier stops a bundler for browsers or Deno from including
// `undici` or a Node module, and keeps `undici` an optional package.
function importOptional(specifier: string): Promise<unknown> {
  return import(specifier);
}

let dnsLookup: Resolver | undefined;
let dnsModule: Promise<Resolver> | undefined;

function loadDns(): Promise<Resolver> {
  dnsModule ??= importOptional("node:dns").then((dns) => {
    const { promises } = dns as { promises: { lookup: Resolver } };
    dnsLookup = promises.lookup.bind(promises);
    return dnsLookup;
  });
  return dnsModule;
}

let directModules: Promise<DirectModules> | undefined;

// The default export of a built-in module is the object that tracing tools
// patch, for example `tls.connect`. The named exports of its ESM namespace do
// not see such a patch, so the direct path calls through the default export.
const defaultOf = (module: unknown) => (module as { default?: unknown }).default ?? module;

function loadDirectModules(): Promise<DirectModules> {
  directModules ??= Promise.all(
    ["node:http2", "node:tls", "node:net"].map((name) => importOptional(name).then(defaultOf)),
  ).then(([http2, tls, net]) => ({ http2, tls, net }) as DirectModules);
  return directModules;
}

/** Resolves a host through `dns.lookup`, which reads /etc/hosts before DNS. */
async function nodeResolve(...args: Parameters<Resolver>): Promise<LookupAddress[]> {
  return (dnsLookup ?? (await loadDns()))(...args);
}

/**
 * Parallel lookups of one host share one call to `resolve`. A failed answer is
 * not kept, so the next lookup tries again.
 */
export function cachedLookup(
  resolve: Resolver = nodeResolve,
  { ttlMs = DNS_TTL_MS, now = Date.now }: { ttlMs?: number; now?: () => number } = {},
): CachedLookup {
  const answers = new Map<string, { addresses: Promise<LookupAddress[]>; expiresAt: number }>();
  const keyOf = (hostname: string, family = 0) => `${family}/${hostname}`;

  function addressesOf(hostname: string, options: LookupOptions): Promise<LookupAddress[]> {
    const key = keyOf(hostname, options.family);
    const cached = answers.get(key);
    if (cached && cached.expiresAt > now()) return cached.addresses;

    const answer = {
      addresses: resolve(hostname, { family: options.family, hints: options.hints, all: true }),
      expiresAt: now() + ttlMs,
    };
    answers.set(key, answer);
    answer.addresses.catch(() => {
      if (answers.get(key) === answer) answers.delete(key);
    });
    return answer.addresses;
  }

  return {
    lookup(hostname, options, callback) {
      addressesOf(hostname, options).then(
        (addresses) => {
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0]?.address, addresses[0]?.family);
        },
        (error) => callback(error),
      );
    },
    forget(hostname) {
      for (const family of [0, 4, 6]) answers.delete(keyOf(hostname, family));
    },
    fresh(hostname) {
      const cached = answers.get(keyOf(hostname));
      return cached !== undefined && cached.expiresAt > now();
    },
  };
}

/**
 * undici's `fetch` with a dispatcher that reads the proxy variables, which the
 * global `fetch` of Node ignores. Returns undefined, with one warning, when
 * undici is not installed or is too old. Never throws, because the global
 * `fetch` carries the requests without the proxy.
 */
async function proxyTransport(importUndici: () => Promise<unknown>): Promise<Transport["proxy"]> {
  let undici: Undici;
  try {
    undici = (await importUndici()) as Undici;
  } catch (cause) {
    warnProxy(
      "the optional `undici` dependency is not installed. Install it (`npm install undici`) to route requests through the proxy.",
      cause,
    );
    return undefined;
  }
  if (typeof undici.EnvHttpProxyAgent !== "function" || typeof undici.fetch !== "function") {
    warnProxy("the installed `undici` is too old; upgrade to undici >= 8 for proxy support.");
    return undefined;
  }
  try {
    return { fetch: undici.fetch, dispatcher: new undici.EnvHttpProxyAgent() };
  } catch (cause) {
    warnProxy("failed to construct undici's EnvHttpProxyAgent.", cause);
    return undefined;
  }
}

/**
 * Returns undefined when the global `fetch` carries every request: outside
 * Node, and when no proxy variable is set and `http2Direct` is off. Never
 * throws. Callers go through {@link sharedTransport}, which builds it once per
 * process.
 */
export async function createTransport(
  options: TransportOptions,
  deps: TransportDeps = {},
): Promise<Transport | undefined> {
  if (!isNode()) return undefined;
  if (options.proxyFromEnv && hasProxyEnv()) {
    const proxy = await proxyTransport(deps.importUndici ?? (() => importOptional("undici")));
    return proxy && { proxy };
  }
  if (!options.http2Direct || isBun()) return undefined;
  try {
    // The first request connects in the turn in which it starts, so the
    // lookup of the cache must not wait for the load of `node:dns` then.
    const [modules] = await Promise.all([loadDirectModules(), loadDns()]);
    const direct = { ...deps.direct, cache: cachedLookup(deps.resolve) };
    let sender = createDirectSender(modules, direct);
    if (options.http2Worker) {
      const { Worker } = (await importOptional(
        "node:worker_threads",
      )) as typeof import("node:worker_threads");
      sender = createWorkerSender(sender, Worker, direct);
    }
    return { direct: sender };
  } catch {
    return undefined;
  }
}

const shared = new Map<string, Promise<Transport | undefined>>();

/**
 * Resolve the transport for `options`, built at most once per process, so
 * that every client shares one HTTP/2 session for each API host.
 */
export function sharedTransport(options: TransportOptions): Promise<Transport | undefined> {
  const key = [
    options.proxyFromEnv,
    options.http2Direct ?? false,
    options.http2Worker ?? false,
  ].join("/");
  let transport = shared.get(key);
  if (!transport) {
    transport = createTransport(options);
    shared.set(key, transport);
  }
  return transport;
}
