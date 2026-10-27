// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// Shared, spec-independent HTTP transport for the generated plumbing clients.
// A single UnikraftCloudError is defined here so `instanceof` works across
// every resource of both the platform and control-plane APIs.

import { type Dispatcher, sharedTransport, type Transport } from "./transport.js";
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
  /**
   * Cache the DNS answer of each API host on Node, so that the connections of
   * a burst share one `dns.lookup` instead of a wait for the libuv thread
   * pool. An answer lives for 5 minutes; a failed connection drops it. Needs
   * the optional `undici` dependency; a custom `fetch` turns it off. Defaults
   * to `true`. Set `false` when a mock or an instrumentation must see the
   * requests on `globalThis.fetch` or on the global undici dispatcher.
   */
  dnsCache?: boolean;
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
 *
 * The plugin packages, `@unikraft/cloud-plugin-<name>-api`, call `request()`,
 * `bytes()` and `stream()` through their `Transport` interface, which lives in
 * unikraft-cloud/plugin-sdk at `js/tools/tsplugingen/templates/transport.ts.tmpl`
 * and ships inside each package, so the package needs no dependency on this
 * one. A change to one of the three signatures, or to {@link RequestArgs} or
 * {@link CallOptions}, must be made there too, and every plugin package must
 * be republished. `test/sandbox.test.ts` checks this class against the
 * published interface.
 */
export class ApiClient {
  protected readonly baseUrl: string;
  protected readonly token?: string;
  protected readonly fetchImpl: FetchLike;
  protected readonly defaultHeaders: Record<string, string>;
  protected readonly proxyFromEnv: boolean;
  readonly #dnsCache: boolean;
  // A custom fetch turns the undici transport off; see #transport().
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
    this.#dnsCache = config.dnsCache ?? true;
  }

  /**
   * A custom fetch owns the transport, and a standalone-undici dispatcher does
   * not work with a foreign fetch, so it gets none.
   */
  #transport(): Promise<Transport | undefined> {
    if (this.#hasCustomFetch) return Promise.resolve(undefined);
    return sharedTransport({ proxyFromEnv: this.proxyFromEnv, dnsCache: this.#dnsCache });
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

    // The dispatcher works only with the fetch of its own undici module, so a
    // transport replaces the configured or global fetch too.
    const transport = await this.#transport();
    let fetchImpl = this.fetchImpl;
    if (transport) {
      fetchImpl = transport.fetch;
      init.dispatcher = transport.dispatcher;
    }

    try {
      return { response: await fetchImpl(url, init), url };
    } catch (cause) {
      const via = transport?.proxied
        ? " (routed through the proxy from your HTTP_PROXY/HTTPS_PROXY environment; check the proxy is reachable and its CA is trusted via NODE_EXTRA_CA_CERTS)"
        : "";
      throw new UnikraftCloudError(`Request to ${url} failed${via}: ${describeCause(cause)}`, {
        kind: "network",
        cause,
      });
    }
  }

  /**
   * Perform a request and return the parsed JSON envelope typed as `T`.
   */
  async request<T>(args: RequestArgs, options: CallOptions = {}): Promise<T> {
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
  async bytes(args: RequestArgs, options: CallOptions = {}): Promise<Uint8Array> {
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
  async *stream<T>(args: RequestArgs, options: CallOptions = {}): AsyncGenerator<T, void, void> {
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
