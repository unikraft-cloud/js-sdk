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

/** undici's `request()`, which skips the WHATWG streams and objects of `fetch`. */
export type RequestFn = (
  url: string,
  options: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    dispatcher: Dispatcher;
  },
) => Promise<{
  statusCode: number;
  statusText?: string;
  body: { text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> };
}>;

/** A version-matched `fetch`, `request` and `dispatcher` from one undici module. */
export interface Transport {
  fetch: FetchLike;
  /** Absent when the installed undici has no `request()`. */
  request?: RequestFn;
  dispatcher: Dispatcher;
  proxied: boolean;
  /** True when the latest connection to `hostname` speaks HTTP/2. */
  multiplexes(hostname: string): boolean;
  /**
   * Starts the DNS lookup of a host into the cache, if the cache has no
   * answer. Absent when the transport does not use the cache.
   */
  resolveEarly?: (hostname: string) => void;
  /** The direct HTTP/2 path. Present only with `http2Direct`, on Node, and with no proxy. */
  direct?: DirectSender;
  /**
   * Prepares the connection to an origin before the first request: opens the
   * direct session, or starts the DNS lookup of the host. Absent when the
   * transport has nothing to prepare.
   */
  open?: (origin: string) => void;
}

export interface TransportOptions {
  proxyFromEnv: boolean;
  dnsCache: boolean;
  /** Offer HTTP/2 in the TLS handshake. Defaults to `false`. */
  http2?: boolean;
  /** The most connections to one origin. Defaults to no limit. */
  maxConnections?: number;
  /** Send the requests that the SDK reads whole over one `node:http2` session per origin. */
  http2Direct?: boolean;
  /** Run the session of `http2Direct` in a worker thread. */
  http2Worker?: boolean;
}

/** The boundaries of {@link createTransport}, which a test can replace. */
export interface TransportDeps {
  /** Loads the `undici` module. Defaults to the `import("undici")` that starts when this module loads. */
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

/** undici's connector, as `buildConnector` returns it. */
type Connector = (
  options: { hostname: string },
  callback: (error: Error | null, socket: unknown) => void,
) => unknown;

/** The parts of the `undici` module that this transport uses. */
interface Undici {
  fetch?: FetchLike;
  request?: RequestFn;
  Agent?: new (options: { connect: Connector; connections?: number }) => Dispatcher;
  EnvHttpProxyAgent?: new (options?: { connect?: Connector; connections?: number }) => Dispatcher;
  buildConnector?: (options: { lookup?: LookupFunction; allowH2?: boolean }) => Connector;
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
// `undici` or a Node module.
function importOptional(specifier: string): Promise<unknown> {
  return import(specifier);
}

let undiciModule: Promise<unknown> | undefined;

function loadUndici(): Promise<unknown> {
  undiciModule ??= importOptional("undici");
  return undiciModule;
}

let dnsLookup: Resolver | undefined;
let dnsModule: Promise<Resolver> | undefined;

// A dynamic import resolves only after the microtasks that are queued, so a
// lookup that awaits it in a burst starts after the setup of every request.
// The module therefore loads with this one, and a lookup calls it at once.
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

// Node needs tens of milliseconds of CPU to load undici. If the first request
// starts the load, every request sent in the same tick waits for it, and a
// burst of creates pays the load in each create. So the load starts when this
// module loads, before the first request. A failed load is reported to
// createTransport, which decides what to do without undici.
if (isNode()) {
  loadUndici().catch(() => {});
  loadDns().catch(() => {});
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

/** The part of a TLS socket that {@link connector} uses. */
interface SessionSocket {
  encrypted?: boolean;
  on(event: "session", listener: (session: unknown) => void): unknown;
}

/**
 * undici's connector, with the DNS cache when `dnsCache` is on.
 *
 * undici keeps the TLS session of a host only through a `WeakRef`. So if a
 * garbage collection occurs between two waves of new connections, each
 * connection of the second wave does a full TLS handshake, and the main thread
 * of a burst spends its time on the handshakes. The connector holds the
 * latest session of each host, so that the next connections resume it.
 */
function connector(
  buildConnector: NonNullable<Undici["buildConnector"]>,
  options: TransportOptions,
  cache: CachedLookup | undefined,
  http2Hosts: Set<string>,
): Connector {
  // undici reads `allowH2` here, not on the Agent, when it gets a connector.
  const connect = buildConnector({
    ...(cache && { lookup: cache.lookup }),
    allowH2: options.http2 ?? false,
  });
  const sessions = new Map<string, unknown>();
  return (target, callback) => {
    const socket = connect(target, (error, connected) => {
      if (error) {
        // The host can move to a new address. A failed connection is the first
        // sign of that, so the next connection resolves the host again.
        cache?.forget(target.hostname);
      } else if ((connected as { alpnProtocol?: string }).alpnProtocol === "h2") {
        http2Hosts.add(target.hostname);
      } else {
        http2Hosts.delete(target.hostname);
      }
      callback(error, connected);
    }) as SessionSocket | undefined;
    if (socket?.encrypted) {
      socket.on("session", (session) => sessions.set(target.hostname, session));
    }
    return socket;
  };
}

/**
 * Returns undefined outside Node, or when `undici` does not load, or does not
 * have a part that this transport needs. The global `fetch` then carries the
 * requests. Never throws, because the global `fetch` works without the
 * transport. Callers go through {@link sharedTransport}, which builds it once
 * per process.
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
  if (!isNode()) return undefined;
  const proxy = options.proxyFromEnv && hasProxyEnv();

  let undici: Undici;
  try {
    undici = (await (deps.importUndici ?? loadUndici)()) as Undici;
  } catch (cause) {
    if (proxy) {
      warnProxy("the `undici` dependency does not load.", cause);
    }
    return undefined;
  }

  const http2Hosts = new Set<string>();
  const multiplexes = (hostname: string) => http2Hosts.has(hostname);
  let connect: Connector | undefined;
  let resolveEarly: ((hostname: string) => void) | undefined;
  const cache = options.dnsCache ? cachedLookup(deps.resolve) : undefined;
  if (typeof undici.buildConnector === "function") {
    try {
      connect = connector(undici.buildConnector, options, cache, http2Hosts);
      // undici asks for the address only when a connection starts, which in a
      // burst is after the setup of every request sent in the same tick. The
      // lookup goes to the libuv thread pool and to the network, so it runs
      // while that setup runs.
      // A fresh answer needs no lookup, and the call for each request of a
      // burst would only build a promise chain through the cache.
      if (cache) {
        resolveEarly = (hostname) => {
          if (!cache.fresh(hostname)) cache.lookup(hostname, {}, () => {});
        };
      }
    } catch {
      // Continue without the connector, because it only makes requests faster.
    }
  }
  const request = typeof undici.request === "function" ? undici.request : undefined;

  if (proxy) {
    if (typeof undici.EnvHttpProxyAgent !== "function" || typeof undici.fetch !== "function") {
      warnProxy("the installed `undici` is too old; upgrade to undici >= 8 for proxy support.");
      return undefined;
    }
    try {
      // EnvHttpProxyAgent gives `connect` only to its agent for direct
      // requests, for example to a host in NO_PROXY. For a proxied request,
      // the proxy resolves the host. It gives `connections` to both agents,
      // so the cap also applies to the tunnels through the proxy. The
      // transport starts no early lookup here: most requests go to the proxy,
      // and the network behind a proxy often has no DNS for the API host.
      const dispatcher = new undici.EnvHttpProxyAgent({
        ...(connect && { connect }),
        ...(options.maxConnections !== undefined && { connections: options.maxConnections }),
      });
      return { fetch: undici.fetch, request, dispatcher, proxied: true, multiplexes };
    } catch (cause) {
      warnProxy("failed to construct undici's EnvHttpProxyAgent.", cause);
      return undefined;
    }
  }

  if (!connect || typeof undici.Agent !== "function" || typeof undici.fetch !== "function") {
    return undefined;
  }
  let direct: DirectSender | undefined;
  if (options.http2Direct && !isBun()) {
    try {
      direct = createDirectSender(await loadDirectModules(), { ...deps.direct, cache });
      if (options.http2Worker) {
        const { Worker } = (await importOptional(
          "node:worker_threads",
        )) as typeof import("node:worker_threads");
        direct = createWorkerSender(direct, Worker, { ...deps.direct, cache });
      }
    } catch {
      // Continue on undici, which carries every request without the option.
    }
  }
  try {
    const dispatcher = new undici.Agent({
      connect,
      ...(options.maxConnections !== undefined && { connections: options.maxConnections }),
    });
    return {
      fetch: undici.fetch,
      request,
      dispatcher,
      proxied: false,
      multiplexes,
      resolveEarly,
      ...(direct && { direct }),
      open: (origin) => {
        if (direct?.open(origin)) return;
        resolveEarly?.(new URL(origin).hostname.replace(/^\[(.*)\]$/, "$1"));
      },
    };
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
  const key = [
    options.proxyFromEnv,
    options.dnsCache,
    options.http2 ?? false,
    options.maxConnections ?? "",
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
