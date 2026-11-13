// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// The direct HTTP/2 path of `http2Direct`: one `node:http2` session for each
// origin carries the requests that the SDK reads whole. It skips the request,
// body and pool objects of undici, which cost the main thread more CPU than the
// HTTP/2 framing itself. Proxies, `http:` origins, hosts that answer only
// HTTP/1.1, and event streams stay on undici.

import type { ClientHttp2Session, ClientHttp2Stream, IncomingHttpHeaders } from "node:http2";
import type { TLSSocket } from "node:tls";
import type { CachedLookup } from "./transport.js";

/** A request for the direct path. The body is a string, so a retry can send it again. */
export interface DirectInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal | null;
}

/** A response of the direct path, read whole. */
export interface DirectResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface DirectSender {
  /**
   * Sends a request over the session of its origin. Returns undefined, and
   * sends nothing, when the direct path does not take the URL: an `http:`
   * origin, or a host that answered HTTP/1.1 before. Rejects with
   * {@link Http1Host} when the host answers HTTP/1.1 now; the request was not
   * sent, so the caller sends it another way.
   */
  send(url: string, init: DirectInit): Promise<DirectResponse> | undefined;
}

/** The host of the request answers only HTTP/1.1, so the direct path did not send it. */
export class Http1Host extends Error {
  constructor(origin: string) {
    super(`${origin} does not answer HTTP/2.`);
    this.name = "Http1Host";
  }
}

export interface DirectModules {
  http2: typeof import("node:http2");
  tls: typeof import("node:tls");
  net: typeof import("node:net");
}

export interface DirectOptions {
  /** The DNS cache of the transport. Without it, each connection resolves the host itself. */
  cache?: CachedLookup;
  /** The time a new session has to finish its TLS handshake. */
  connectTimeoutMs?: number;
  /** The time a stream may go without a frame from the server, before and after the headers. */
  answerTimeoutMs?: number;
  /** The time a session with no open stream stays open. */
  idleTimeoutMs?: number;
}

// The same limits as undici's defaults, so the option changes the transport,
// not how long a request may take.
export const CONNECT_TIMEOUT_MS = 10_000;
export const ANSWER_TIMEOUT_MS = 300_000;
export const IDLE_TIMEOUT_MS = 60_000;

// A refused stream is one that the server did not process, so a retry is safe
// for every method. A request gets two retries for refusals on an open
// session, which a server under load sends, and two more for a session that
// closes under it, for example on a GOAWAY when the server reloads. So a
// GOAWAY in a burst does not use up the retries of a request that the server
// also refuses.
const MAX_RETRIES = 2;

interface Entry {
  session: ClientHttp2Session;
  /** Streams that have not settled. The session holds the process open only while this is above 0. */
  inFlight: number;
  /** The sweep at which `inFlight` became 0. */
  idleSince: number;
}

/** A stream that has not settled, for the sweep of the answer timeout. */
interface Waiting {
  /** The sweep at which the stream last got a frame. */
  seen: number;
  expire: () => void;
}

/** The origin and the path of a URL that the SDK built from a base URL and a path. */
export function splitUrl(url: string): { origin: string; path: string } {
  // The base URL is a plain origin with an optional path, so the first slash
  // after the scheme starts the path. This saves a `URL` object per request.
  const slash = url.indexOf("/", url.indexOf("//") + 2);
  return slash === -1
    ? { origin: url, path: "/" }
    : { origin: url.slice(0, slash), path: url.slice(slash) };
}

/** The headers of an HTTP/2 request: the pseudo-headers, and every name in lower case. */
export function requestHeaders(path: string, init: DirectInit): Record<string, string> {
  const headers: Record<string, string> = { ":method": init.method, ":path": path };
  for (const name in init.headers) headers[name.toLowerCase()] = init.headers[name] as string;
  if (init.body !== undefined) headers["content-length"] = String(Buffer.byteLength(init.body));
  return headers;
}

export function toResponse(status: number, body: Buffer): DirectResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    // HTTP/2 has no reason phrase.
    statusText: "",
    text: () => Promise.resolve(body.toString("utf8")),
    arrayBuffer: () =>
      Promise.resolve(
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      ),
  };
}

function timeoutError(message: string): Error {
  return Object.assign(new Error(message), { code: "ETIMEDOUT" });
}

/**
 * The error of the session, for a stream that waited for a session that
 * failed. Node rejects such a stream with a cancel, and puts the reason, for
 * example `ECONNREFUSED`, in its `cause`.
 */
function sessionError(error: unknown): unknown {
  const { code, cause } = error as { code?: unknown; cause?: unknown };
  return code === "ERR_HTTP2_STREAM_CANCEL" && cause instanceof Error ? cause : error;
}

export function createDirectSender(
  { http2, tls, net }: DirectModules,
  {
    cache,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    answerTimeoutMs = ANSWER_TIMEOUT_MS,
    idleTimeoutMs = IDLE_TIMEOUT_MS,
  }: DirectOptions = {},
): DirectSender {
  const { NGHTTP2_CANCEL, NGHTTP2_REFUSED_STREAM } = http2.constants;
  const sessions = new Map<string, Entry>();
  const http1Origins = new Set<string>();
  // The latest TLS session of each origin, so that a new connection resumes
  // it and skips the full handshake.
  const tlsSessions = new Map<string, Buffer>();

  // One coarse timer checks the answer timeout of every stream and the idle
  // time of every session. A timer for each stream, or a session timer that
  // Node moves at each frame, costs the main thread more in a burst than the
  // HTTP/2 framing of the requests. A timeout fires up to one tenth of its
  // value late.
  const period = Math.max(5, Math.min(answerTimeoutMs, idleTimeoutMs) / 10);
  const answerSweeps = Math.ceil(answerTimeoutMs / period);
  const idleSweeps = Math.ceil(idleTimeoutMs / period);
  const waiting = new Set<Waiting>();
  let sweeps = 0;
  let sweeper: ReturnType<typeof setInterval> | undefined;
  function sweep() {
    sweeps++;
    for (const w of waiting) if (sweeps - w.seen >= answerSweeps) w.expire();
    for (const entry of sessions.values()) {
      if (entry.inFlight === 0 && sweeps - entry.idleSince >= idleSweeps) entry.session.close();
    }
    if (sessions.size === 0 && waiting.size === 0) {
      clearInterval(sweeper);
      sweeper = undefined;
    }
  }
  function startSweeper() {
    if (sweeper) return;
    sweeper = setInterval(sweep, period);
    sweeper.unref();
  }

  function connect(origin: string): Entry {
    const { hostname, port } = new URL(origin);
    const host = hostname.replace(/^\[(.*)\]$/, "$1");
    let connected = false;
    let socket: TLSSocket | undefined;
    const session = http2.connect(origin, {
      // The SDK makes the TLS socket so that it can offer HTTP/1.1 too, and
      // so learn from the handshake that a host speaks only HTTP/1.1. With
      // only `h2` offered, some servers end the handshake with an alert, and
      // others finish it with no protocol.
      createConnection: () => {
        socket = tls.connect({
          host,
          port: Number(port) || 443,
          ALPNProtocols: ["h2", "http/1.1"],
          ...(net.isIP(host) === 0 && { servername: host }),
          // The `LookupFunction` of this SDK types the callback for both
          // answer forms, which the overloads of `net.LookupFunction` cannot
          // express.
          ...(cache && { lookup: cache.lookup as import("node:net").LookupFunction }),
          ...(tlsSessions.has(origin) && { session: tlsSessions.get(origin) }),
        });
        socket.on("session", (ticket: Buffer) => tlsSessions.set(origin, ticket));
        // The socket reports its error before the session fails its streams,
        // so the next request already sees the result of this.
        socket.once("error", (error) => {
          if (!connected) failedConnect(error);
        });
        return socket;
      },
    });
    const entry: Entry = { session, inFlight: 0, idleSince: sweeps };
    const drop = () => {
      if (sessions.get(origin) === entry) sessions.delete(origin);
    };
    function failedConnect(error: unknown) {
      drop();
      // The alert of a server that offers no protocol that the client asked for.
      if ((error as { code?: unknown })?.code === "ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL") {
        http1Origins.add(origin);
      } else {
        // The host can move to a new address. A failed connection is the
        // first sign of that, so the next connection resolves the host again.
        cache?.forget(host);
      }
    }
    // The socket must be destroyed itself: `destroy` on a session that still
    // connects leaves its socket and the pending TCP connect alone.
    const giveUp = (error: Error) => {
      failedConnect(error);
      socket?.destroy(error);
      session.destroy(error);
    };
    const timer = setTimeout(
      () =>
        giveUp(timeoutError(`The connection to ${origin} did not open in ${connectTimeoutMs} ms.`)),
      connectTimeoutMs,
    );
    timer.unref();

    // The check must wait for this event. A socket that the SDK destroys in
    // its own "secureConnect" listener, which runs before the one of
    // `node:http2`, stops the process on a failed assertion in Node.
    session.once("connect", () => {
      clearTimeout(timer);
      connected = true;
      if (session.alpnProtocol !== "h2") {
        http1Origins.add(origin);
        // The streams that wait for the session fail with a cancel and were
        // not sent, so the caller sends them again through undici.
        session.destroy();
      }
    });
    // A session without an "error" listener throws its error as an uncaught
    // exception, which an idle session must never do.
    session.on("error", () => {
      clearTimeout(timer);
      drop();
    });
    session.on("close", () => {
      clearTimeout(timer);
      drop();
    });
    session.on("goaway", drop);
    startSweeper();
    // An idle session, and a session that still connects, must not keep the
    // process alive.
    session.unref();
    sessions.set(origin, entry);
    return entry;
  }

  function sessionFor(origin: string): Entry {
    const found = sessions.get(origin);
    if (found && !found.session.closed && !found.session.destroyed) return found;
    return connect(origin);
  }

  /** The retry counts for a refused stream, or undefined when the request has used its retries. */
  function retry(
    entry: Entry,
    { refused, closed }: { refused: number; closed: number },
  ): { refused: number; closed: number } | undefined {
    // Node closes a session when it gets a GOAWAY, so a closed session
    // means that the GOAWAY refused the stream, not the load of the server.
    if (entry.session.closed || entry.session.destroyed) {
      return closed < MAX_RETRIES ? { refused, closed: closed + 1 } : undefined;
    }
    return refused < MAX_RETRIES ? { refused: refused + 1, closed } : undefined;
  }

  function attempt(
    origin: string,
    headers: Record<string, string>,
    init: DirectInit,
    retries: { refused: number; closed: number },
  ): Promise<DirectResponse> {
    return new Promise<DirectResponse>((resolve, reject) => {
      const signal = init.signal ?? undefined;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const entry = sessionFor(origin);
      let stream: ClientHttp2Stream;
      try {
        // A request made before the TLS handshake ends waits inside the
        // session. Node sends it at once after the handshake, and does not
        // wait for the SETTINGS frame of the server.
        stream = entry.session.request(headers, { endStream: init.body === undefined });
      } catch (error) {
        // The session closed between the check and the request, for example
        // on a GOAWAY that came in the same turn. Nothing was sent.
        if (sessions.get(origin) === entry) sessions.delete(origin);
        if (retries.closed < MAX_RETRIES) {
          resolve(attempt(origin, headers, init, { ...retries, closed: retries.closed + 1 }));
        } else reject(error);
        return;
      }
      if (entry.inFlight++ === 0) entry.session.ref();
      const chunks: Buffer[] = [];
      let length = 0;
      let status = 0;
      let settled = false;
      let onAbort: (() => void) | undefined;
      const wait: Waiting = {
        seen: sweeps,
        expire: () => {
          fail(timeoutError(`${origin} sent no data for ${answerTimeoutMs} ms.`));
          stream.close(NGHTTP2_CANCEL);
        },
      };
      waiting.add(wait);
      startSweeper();
      const settle = () => {
        if (settled) return false;
        settled = true;
        if (--entry.inFlight === 0) {
          entry.idleSince = sweeps;
          if (!entry.session.destroyed) entry.session.unref();
        }
        waiting.delete(wait);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        return true;
      };
      const fail = (error: unknown) => {
        if (!settle()) return;
        if (signal?.aborted) reject(signal.reason);
        else if (http1Origins.has(origin)) reject(new Http1Host(origin));
        else {
          const next =
            stream.rstCode === NGHTTP2_REFUSED_STREAM ? retry(entry, retries) : undefined;
          if (next) resolve(attempt(origin, headers, init, next));
          else reject(sessionError(error));
        }
      };
      if (signal) {
        onAbort = () => {
          fail(signal.reason);
          stream.close(NGHTTP2_CANCEL);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      stream.on("response", (h: IncomingHttpHeaders) => {
        status = Number(h[":status"]);
        wait.seen = sweeps;
      });
      stream.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        length += chunk.length;
        wait.seen = sweeps;
      });
      stream.on("end", () => {
        if (status === 0) {
          fail(new Error(`${origin} ended the stream before it sent a status.`));
          return;
        }
        if (!settle()) return;
        resolve(
          toResponse(
            status,
            chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks, length),
          ),
        );
      });
      stream.on("error", fail);
      // A reset with no error code ends the stream without "end" or "error".
      // "close" also comes after a normal end, so the error is made only for a
      // stream that has not settled: an error captures a stack trace.
      stream.on("close", () => {
        if (!settled) {
          fail(new Error(`${origin} closed the stream before its end (code ${stream.rstCode}).`));
        }
      });
      if (init.body !== undefined) stream.end(init.body);
    });
  }

  return {
    send(url, init) {
      if (!url.startsWith("https://")) return undefined;
      const { origin, path } = splitUrl(url);
      if (http1Origins.has(origin)) return undefined;
      return attempt(origin, requestHeaders(path, init), init, { refused: 0, closed: 0 });
    },
  };
}
