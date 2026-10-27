// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// Node's fetch resolves the host of each new connection with `dns.lookup` on
// the libuv thread pool of 4 threads, so a burst opens its connections only as
// fast as that pool resolves the same name. This transport caches the answer.

import type { FetchLike } from "./http.js";

/** Opaque undici `Dispatcher` handle. */
export interface Dispatcher {
  dispatch(...args: never[]): boolean;
}

/** A version-matched `fetch` and `dispatcher` pair from one undici module. */
export interface Transport {
  fetch: FetchLike;
  dispatcher: Dispatcher;
  proxied: boolean;
}

export interface TransportOptions {
  proxyFromEnv: boolean;
  dnsCache: boolean;
}

/** The boundaries of {@link createTransport}, which a test can replace. */
export interface TransportDeps {
  /** Loads the `undici` module. Defaults to a dynamic `import("undici")`. */
  importUndici?: () => Promise<unknown>;
  /** Resolves a host on a cache miss. Defaults to `dns.promises.lookup`. */
  resolve?: Resolver;
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
}

/** undici's connector, as `buildConnector` returns it. */
type Connector = (
  options: { hostname: string },
  callback: (error: Error | null, socket: unknown) => void,
) => unknown;

/** The parts of the `undici` module that this transport uses. */
interface Undici {
  fetch?: FetchLike;
  Agent?: new (options: { connect: Connector }) => Dispatcher;
  EnvHttpProxyAgent?: new (options?: { connect: Connector }) => Dispatcher;
  buildConnector?: (options: { lookup: LookupFunction }) => Connector;
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

/** True when any HTTP proxy environment variable is set. */
function hasProxyEnv(): boolean {
  if (typeof process === "undefined" || !process.env) return false;
  return PROXY_ENV_VARS.some((name) => {
    const v = process.env[name];
    return typeof v === "string" && v.length > 0;
  });
}

// Non-literal specifiers keep `undici` an optional, lazily loaded dependency.
// They also stop a bundler for browsers or Deno from including `undici` or
// `node:dns`.
function importOptional(specifier: string): Promise<unknown> {
  return import(specifier);
}

/** Resolves a host through `dns.lookup`, which reads /etc/hosts before DNS. */
async function nodeResolve(...args: Parameters<Resolver>): Promise<LookupAddress[]> {
  const dns = (await importOptional("node:dns")) as { promises: { lookup: Resolver } };
  return dns.promises.lookup(...args);
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
  };
}

function cachingConnector(
  buildConnector: NonNullable<Undici["buildConnector"]>,
  resolve?: Resolver,
): Connector {
  const cache = cachedLookup(resolve);
  const connect = buildConnector({ lookup: cache.lookup });
  return (options, callback) =>
    connect(options, (error, socket) => {
      // The host can move to a new address. A failed connection is the first
      // sign of that, so the next connection resolves the host again.
      if (error) cache.forget(options.hostname);
      callback(error, socket);
    });
}

/**
 * Returns undefined when the global `fetch` must carry the requests: `undici`
 * is not installed, or neither a proxy nor the DNS cache is in use. Never
 * throws, because the global `fetch` works without the transport. Callers go
 * through {@link sharedTransport}, which builds it once per process.
 *
 * The dispatcher and fetch come from the SAME undici module. A dispatcher must
 * only be used with its own version's `fetch`: mixing a standalone-undici
 * dispatcher into Node's bundled `fetch` fails with `UND_ERR_INVALID_ARG:
 * invalid onRequestStart method`.
 */
export async function createTransport(
  options: TransportOptions,
  deps: TransportDeps = {},
): Promise<Transport | undefined> {
  const proxy = options.proxyFromEnv && hasProxyEnv();
  if (!proxy && !options.dnsCache) return undefined;

  let undici: Undici;
  try {
    undici = (await (deps.importUndici ?? (() => importOptional("undici")))()) as Undici;
  } catch (cause) {
    if (proxy) {
      warnProxy(
        "the optional `undici` dependency is not installed. Install it (`npm install undici`) to route requests through the proxy.",
        cause,
      );
    }
    return undefined;
  }

  let connect: Connector | undefined;
  if (options.dnsCache && typeof undici.buildConnector === "function") {
    try {
      connect = cachingConnector(undici.buildConnector, deps.resolve);
    } catch {
      // Continue without the cache, because it only makes requests faster.
    }
  }

  if (proxy) {
    if (typeof undici.EnvHttpProxyAgent !== "function" || typeof undici.fetch !== "function") {
      warnProxy("the installed `undici` is too old; upgrade to undici >= 8 for proxy support.");
      return undefined;
    }
    try {
      // EnvHttpProxyAgent gives `connect` only to its agent for direct
      // requests, for example to a host in NO_PROXY. For a proxied request,
      // the proxy resolves the host.
      const dispatcher = new undici.EnvHttpProxyAgent(connect && { connect });
      return { fetch: undici.fetch, dispatcher, proxied: true };
    } catch (cause) {
      warnProxy("failed to construct undici's EnvHttpProxyAgent.", cause);
      return undefined;
    }
  }

  if (!connect || typeof undici.Agent !== "function" || typeof undici.fetch !== "function") {
    return undefined;
  }
  try {
    return { fetch: undici.fetch, dispatcher: new undici.Agent({ connect }), proxied: false };
  } catch {
    return undefined;
  }
}

const shared = new Map<string, Promise<Transport | undefined>>();

/**
 * Resolve the transport for `options`, built at most once per process, so
 * that every client shares one connection pool and one DNS cache.
 */
export function sharedTransport(options: TransportOptions): Promise<Transport | undefined> {
  const key = `${options.proxyFromEnv}/${options.dnsCache}`;
  let transport = shared.get(key);
  if (!transport) {
    transport = createTransport(options);
    shared.set(key, transport);
  }
  return transport;
}
