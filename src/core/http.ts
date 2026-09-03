// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// Shared, spec-independent HTTP transport for the generated plumbing clients.
// A single UnikraftCloudError is defined here so `instanceof` works across
// every resource of both the platform and control-plane APIs.

import { stripTrailingSlashes } from "./url.js";

/** A single error entry returned within a response envelope. */
export interface ResponseError {
  /** The HTTP status code associated with the error. */
  status: number;
  /** Optional human-readable detail. */
  message?: string;
}

/**
 * The common response envelope. Every Platform API response is wrapped in this
 * shape; `data` carries the operation-specific payload.
 */
export interface ApiResponse<T = unknown> {
  // Bulk operations report "partial_success" when only some of the referenced
  // resources could be acted on; `errors` then describes the failures.
  status: "success" | "error" | "partial_success";
  message?: string;
  data?: T;
  errors?: readonly ResponseError[];
  op_time_us: number;
}

/** A value that can be serialised into a query string. */
export type QueryValue =
  | string
  | number
  | boolean
  | Array<string | number | boolean>
  | undefined
  | null;

/** Per-call options accepted by every generated operation. */
export interface CallOptions {
  /** Abort the request via an `AbortSignal`. */
  signal?: AbortSignal;
  /** Extra headers merged over the client defaults for this call only. */
  headers?: Record<string, string>;
  /** Override the base URL (e.g. to target a different metro) for this call. */
  baseUrl?: string;
}

/** Minimal `fetch` signature the client depends on. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Opaque undici `Dispatcher` handle (resolved from proxy env vars on Node). */
interface Dispatcher {
  dispatch(...args: never[]): boolean;
}

/** A version-matched `fetch` + `dispatcher` pair from a single undici module. */
interface ProxyTransport {
  fetch: FetchLike;
  dispatcher: Dispatcher;
}

/** `fetch` init plus the undici-only `dispatcher` extension. */
type RequestInitWithDispatcher = RequestInit & { dispatcher?: Dispatcher };

/** Configuration for the plumbing {@link ApiClient}. */
export interface ApiClientConfig {
  /** Fully-qualified API base URL, e.g. `https://api.fra.unikraft.cloud`. */
  baseUrl: string;
  /** Bearer token used for authentication. */
  token?: string;
  /** Custom `fetch` implementation (defaults to the global `fetch`). */
  fetch?: FetchLike;
  /** Default headers sent with every request. */
  headers?: Record<string, string>;
  /** User-Agent value sent with every request. */
  userAgent?: string;
  /**
   * Honour the `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` environment variables
   * (any case) on Node by routing requests through the proxy. Requires the
   * optional `undici` dependency. Defaults to `true`; set `false` to opt out.
   */
  proxyFromEnv?: boolean;
}

/**
 * The kind of failure represented by an {@link UnikraftCloudError}. `"fanout"`
 * covers failures that are not a single request's fault: a multi-metro
 * operation where some metros failed, or an ambiguous or unusable metro scope.
 * `"config"` covers a call that could never be sent as configured — a missing
 * token, or two options that contradict each other. `"timeout"` covers a wait
 * that ran out of time; it carries no `status`, because no single request
 * failed.
 */
export type UnikraftCloudErrorKind = "http" | "network" | "parse" | "fanout" | "config" | "timeout";

/** Error thrown when a request fails at the transport or HTTP level. */
export class UnikraftCloudError extends Error {
  /** Whether this was an HTTP error, a network failure, or a parse failure. */
  readonly kind: UnikraftCloudErrorKind;
  /** HTTP status code, when available. */
  readonly status?: number;
  /** Structured errors returned in the response envelope, when available. */
  readonly errors?: readonly ResponseError[];
  /** The parsed response body, when available. */
  readonly body?: unknown;

  constructor(
    message: string,
    opts: {
      kind: UnikraftCloudErrorKind;
      status?: number;
      errors?: readonly ResponseError[];
      body?: unknown;
      cause?: unknown;
    },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "UnikraftCloudError";
    this.kind = opts.kind;
    this.status = opts.status;
    this.errors = opts.errors;
    this.body = opts.body;
  }
}

/** Internal shape passed to {@link ApiClient.request}. */
export interface RequestArgs {
  method: string;
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
}

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

/**
 * Build a dispatcher that honours the proxy environment variables, using
 * undici's `EnvHttpProxyAgent` (which also respects `NO_PROXY`). Returns
 * undefined when no proxy is configured or `undici` is unavailable. Never
 * throws — proxy support is best-effort. Callers go through
 * {@link proxyTransport}, which memoises the result process-wide.
 *
 * The dispatcher and fetch come from the SAME undici module. A dispatcher must
 * only be used with its own version's `fetch`: mixing a standalone-undici
 * dispatcher into Node's bundled `fetch` fails with `UND_ERR_INVALID_ARG:
 * invalid onRequestStart method`.
 */
async function createProxyTransport(): Promise<ProxyTransport | undefined> {
  if (!hasProxyEnv()) return undefined;

  // Non-literal specifier: keeps `undici` an optional, lazily-loaded dep and
  // avoids eager bundling in browser/Deno builds.
  const specifier = "undici";
  let undici: {
    EnvHttpProxyAgent?: new () => Dispatcher;
    fetch?: FetchLike;
  };
  try {
    undici = await import(specifier);
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
 * Process-global memo for {@link createProxyTransport} to reuse the same
 * connection pool across every client.
 */
let proxyMemo: Promise<ProxyTransport | undefined> | undefined;

/** Resolve the shared proxy transport, building it at most once per process. */
function proxyTransport(): Promise<ProxyTransport | undefined> {
  proxyMemo ??= createProxyTransport();
  return proxyMemo;
}

/**
 * Build a human-readable message from an error and its `cause` chain. `fetch`
 * reports a generic "fetch failed"; the useful detail (e.g. `ECONNREFUSED
 * 10.0.0.148:9090`, or a TLS certificate error from a MITM proxy) lives in
 * nested causes.
 */
function describeCause(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const e = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === "string") parts.push(e.code);
    if (typeof e.message === "string" && e.message) parts.push(e.message);
    current = e.cause;
  }
  return parts.length > 0 ? [...new Set(parts)].join(": ") : String(err);
}

/** Separator between two server-sent events (`\n\n`, `\r\n\r\n` or `\r\r`). */
const SSE_EVENT_BOUNDARY = /\r\n\r\n|\n\n|\r\r/;

/**
 * Extract the payload of one server-sent event block: the concatenation of its
 * `data:` field values. Returns undefined for blocks without any (comments and
 * keep-alives), which the caller skips.
 */
function sseData(block: string): string | undefined {
  const values: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    // A leading colon marks a comment (used for keep-alives).
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if ((colon === -1 ? line : line.slice(0, colon)) !== "data") continue;
    const value = colon === -1 ? "" : line.slice(colon + 1);
    values.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return values.length > 0 ? values.join("\n") : undefined;
}

/**
 * Parse one server-sent event block into its JSON payload, or undefined when
 * the block carries no data (a comment, keep-alive, or trailing whitespace).
 */
function parseSseEvent(block: string, url: string, status: number): unknown {
  const data = sseData(block);
  if (data === undefined || data === "") return undefined;
  try {
    return JSON.parse(data);
  } catch (cause) {
    throw new UnikraftCloudError(`Failed to parse event stream from ${url}`, {
      kind: "parse",
      status,
      body: data,
      cause,
    });
  }
}

/** Serialise a query object into a URL search string (form/explode style). */
function encodeQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Base transport for the generated resource clients. Performs authenticated
 * `fetch` requests and returns the parsed response envelope. Throws
 * {@link UnikraftCloudError} on network failures and non-2xx HTTP responses.
 */
export class ApiClient {
  protected readonly baseUrl: string;
  protected readonly token?: string;
  protected readonly fetchImpl: FetchLike;
  protected readonly defaultHeaders: Record<string, string>;
  protected readonly proxyFromEnv: boolean;
  // Whether the caller supplied a custom fetch (suppresses env-proxy injection).
  readonly #hasCustomFetch: boolean;

  constructor(config: ApiClientConfig) {
    this.baseUrl = stripTrailingSlashes(config.baseUrl);
    this.token = config.token;
    this.#hasCustomFetch = typeof config.fetch === "function";
    const resolvedFetch = config.fetch ?? globalThis.fetch;
    if (typeof resolvedFetch !== "function") {
      throw new UnikraftCloudError(
        "No fetch implementation available; pass `fetch` in the client config for this runtime.",
        { kind: "network" },
      );
    }
    // Bind the global fetch to globalThis (required by browsers and Node); use
    // a caller-supplied fetch as-is so its own `this` binding is preserved.
    this.fetchImpl = this.#hasCustomFetch ? resolvedFetch : resolvedFetch.bind(globalThis);
    this.defaultHeaders = { ...config.headers };
    if (config.userAgent) this.defaultHeaders["User-Agent"] = config.userAgent;
    this.proxyFromEnv = config.proxyFromEnv ?? true;
  }

  /**
   * Resolve the proxy transport (undici fetch + dispatcher), shared process-wide
   * by {@link proxyTransport}. Skipped when a custom fetch was supplied — the
   * caller owns transport, and a standalone-undici dispatcher is incompatible
   * with a foreign fetch.
   */
  #proxyTransport(): Promise<ProxyTransport | undefined> {
    if (!this.proxyFromEnv || this.#hasCustomFetch) return Promise.resolve(undefined);
    return proxyTransport();
  }

  /**
   * Perform the authenticated fetch shared by {@link ApiClient.request} and
   * {@link ApiClient.stream}, returning the raw response alongside the resolved
   * URL (used in error messages). Throws on transport failures only; the caller
   * decides how to interpret the status and body.
   */
  async #send(
    args: RequestArgs,
    options: CallOptions,
    accept: string,
  ): Promise<{ response: Response; url: string }> {
    const base = stripTrailingSlashes(options.baseUrl ?? this.baseUrl);
    const url = base + args.path + encodeQuery(args.query);

    const headers: Record<string, string> = {
      accept,
      ...this.defaultHeaders,
      ...options.headers,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    const method = args.method.toUpperCase();
    const canHaveBody = method !== "GET" && method !== "HEAD";
    let bodyInit: string | undefined;
    if (canHaveBody && args.body !== undefined && args.body !== null) {
      bodyInit = JSON.stringify(args.body);
      headers["content-type"] = "application/json";
    }

    const init: RequestInitWithDispatcher = {
      method,
      headers,
      body: bodyInit,
      signal: options.signal,
    };

    // When a proxy env var is set, route through undici's own fetch + matching
    // dispatcher; otherwise use the configured/global fetch.
    const proxy = await this.#proxyTransport();
    let fetchImpl = this.fetchImpl;
    if (proxy) {
      fetchImpl = proxy.fetch;
      init.dispatcher = proxy.dispatcher;
    }

    try {
      return { response: await fetchImpl(url, init), url };
    } catch (cause) {
      const via = init.dispatcher
        ? " (routed through the proxy from your HTTP_PROXY/HTTPS_PROXY environment; check the proxy is reachable and its CA is trusted via NODE_EXTRA_CA_CERTS)"
        : "";
      throw new UnikraftCloudError(`Request to ${url} failed${via}: ${describeCause(cause)}`, {
        kind: "network",
        cause,
      });
    }
  }

  /** Perform a request and return the parsed JSON envelope typed as `T`. */
  protected async request<T>(args: RequestArgs, options: CallOptions = {}): Promise<T> {
    const { response, url } = await this.#send(args, options, "application/json");

    const text = await response.text();
    let parsed: unknown;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch (cause) {
        if (!response.ok) {
          throw new UnikraftCloudError(`HTTP ${response.status} ${response.statusText}`, {
            kind: "http",
            status: response.status,
            body: text,
            cause,
          });
        }
        throw new UnikraftCloudError(`Failed to parse response body from ${url}`, {
          kind: "parse",
          status: response.status,
          body: text,
          cause,
        });
      }
    }

    if (!response.ok) {
      const envelope = parsed as ApiResponse<unknown> | undefined;
      throw new UnikraftCloudError(
        envelope?.message ?? `HTTP ${response.status} ${response.statusText}`,
        {
          kind: "http",
          status: response.status,
          errors: envelope?.errors,
          body: parsed,
        },
      );
    }

    return parsed as T;
  }

  /**
   * Perform a request whose response is an unenveloped `application/octet-stream`
   * body and return it verbatim. Used by operations that download bytes — a raw
   * command log or a file — where routing through {@link ApiClient.request}
   * would `JSON.parse` the payload.
   *
   * The whole body is buffered, as `Response.bytes()` does; nothing is streamed
   * (unlike {@link ApiClient.stream}, which is named for its SSE delivery).
   */
  protected async bytes(args: RequestArgs, options: CallOptions = {}): Promise<Uint8Array> {
    const { response } = await this.#send(args, options, "application/octet-stream");

    if (!response.ok) {
      // A failure is still enveloped JSON (and may be an empty body, e.g. the
      // 410 returned for deleted logs), so decode it the way stream() does.
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        // Not an envelope; the raw text is reported as the error body instead.
      }
      const envelope = parsed as ApiResponse<unknown> | undefined;
      throw new UnikraftCloudError(
        envelope?.message ?? `HTTP ${response.status} ${response.statusText}`,
        {
          kind: "http",
          status: response.status,
          errors: envelope?.errors,
          body: parsed ?? text,
        },
      );
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Perform a request whose response is a `text/event-stream` and yield each
   * event's JSON payload typed as `T`. The generator ends when the server closes
   * the stream; `break` out of the loop (or pass a `signal`) to stop early and
   * release the connection.
   *
   * @example
   * for await (const event of api.checkAuthorization({ body })) { ... }
   */
  protected async *stream<T>(
    args: RequestArgs,
    options: CallOptions = {},
  ): AsyncGenerator<T, void, void> {
    const { response, url } = await this.#send(args, options, "text/event-stream");

    if (!response.ok) {
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        // Not an envelope; the raw text is reported as the error body instead.
      }
      const envelope = parsed as ApiResponse<unknown> | undefined;
      throw new UnikraftCloudError(
        envelope?.message ?? `HTTP ${response.status} ${response.statusText}`,
        {
          kind: "http",
          status: response.status,
          errors: envelope?.errors,
          body: parsed ?? text,
        },
      );
    }

    if (!response.body) return;

    // Read with an explicit reader rather than async-iterating the body: not
    // every runtime makes a ReadableStream async-iterable.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

        for (
          let boundary = SSE_EVENT_BOUNDARY.exec(buffer);
          boundary;
          boundary = SSE_EVENT_BOUNDARY.exec(buffer)
        ) {
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const event = parseSseEvent(block, url, response.status);
          if (event !== undefined) yield event as T;
        }

        if (done) {
          // A last event may arrive without its trailing blank line.
          const event = parseSseEvent(buffer, url, response.status);
          if (event !== undefined) yield event as T;
          return;
        }
      }
    } finally {
      // Cancel on early return/throw so the connection isn't left dangling.
      await reader.cancel().catch(() => {});
    }
  }
}
