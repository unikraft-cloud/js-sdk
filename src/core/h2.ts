// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

import type { ClientHttp2Session, ClientHttp2Stream, IncomingHttpHeaders } from "node:http2";
import type { TLSSocket } from "node:tls";
import type { CachedLookup } from "./transport.js";

export interface DirectInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal | null;
}

export interface DirectResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface DirectSender {
  send(url: string, init: DirectInit): Promise<DirectResponse | "not-sent">;
  takes(url: string): boolean;
  open(origin: string): boolean;
}

export interface DirectModules {
  http2: typeof import("node:http2");
  tls: typeof import("node:tls");
  net: typeof import("node:net");
}

export interface DirectOptions {
  cache?: Pick<CachedLookup, "lookup" | "forget">;
  connectTimeoutMs?: number;
  stallTimeoutMs?: number;
  idleTimeoutMs?: number;
  earlyConnectTimeoutMs?: number;
  onProtocol?: (origin: string, protocol: "h2" | "http/1.1") => void;
}

export const CONNECT_TIMEOUT_MS = 10_000;
export const STALL_TIMEOUT_MS = 300_000;
export const IDLE_TIMEOUT_MS = 60_000;

// A TCP connect that waits for an answer keeps the process alive, and an
// unref of the socket does not change that.
export const EARLY_CONNECT_TIMEOUT_MS = 1_000;

// A refused stream is one that the server did not process, so a retry is safe
// for every method.
const MAX_RETRIES = 2;

const SWEEPS_PER_TIMEOUT = 10;

interface Entry {
  session: ClientHttp2Session;
  inFlight: number;
  idleSince: number;
}

interface Waiting {
  seen: number;
  expire: () => void;
}

export function splitUrl(url: string): { origin: string; path: string } {
  const slash = url.indexOf("/", url.indexOf("//") + 2);
  return slash === -1
    ? { origin: url, path: "/" }
    : { origin: url.slice(0, slash), path: url.slice(slash) };
}

function requestHeaders(path: string, init: DirectInit): Record<string, string> {
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
    stallTimeoutMs = STALL_TIMEOUT_MS,
    idleTimeoutMs = IDLE_TIMEOUT_MS,
    earlyConnectTimeoutMs = EARLY_CONNECT_TIMEOUT_MS,
    onProtocol,
  }: DirectOptions = {},
): DirectSender {
  const { NGHTTP2_CANCEL, NGHTTP2_NO_ERROR, NGHTTP2_REFUSED_STREAM } = http2.constants;
  const sessions = new Map<string, Entry>();
  const http1Origins = new Set<string>();
  const tlsSessions = new Map<string, Buffer>();
  const http1Only = (origin: string) => {
    http1Origins.add(origin);
    onProtocol?.(origin, "http/1.1");
  };

  const sweepMs = Math.max(5, Math.min(stallTimeoutMs, idleTimeoutMs) / SWEEPS_PER_TIMEOUT);
  const stallSweeps = Math.ceil(stallTimeoutMs / sweepMs);
  const idleSweeps = Math.ceil(idleTimeoutMs / sweepMs);
  const waiting = new Set<Waiting>();
  let sweeps = 0;
  let sweeper: ReturnType<typeof setInterval> | undefined;
  function sweep() {
    sweeps++;
    for (const w of waiting) if (sweeps - w.seen >= stallSweeps) w.expire();
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
    sweeper = setInterval(sweep, sweepMs);
    sweeper.unref();
  }

  function connect(origin: string, early: boolean): Entry {
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
          ...(cache && { lookup: cache.lookup as import("node:net").LookupFunction }),
          ...(tlsSessions.has(origin) && { session: tlsSessions.get(origin) }),
        });
        socket.on("session", (ticket: Buffer) => tlsSessions.set(origin, ticket));
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
      if ((error as { code?: unknown })?.code === "ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL") {
        http1Only(origin);
      } else {
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
    if (early) {
      const earlyTimer = setTimeout(() => {
        if (socket?.connecting && entry.inFlight === 0) {
          giveUp(
            timeoutError(
              `The early connection to ${origin} did not open in ${earlyConnectTimeoutMs} ms.`,
            ),
          );
        }
      }, earlyConnectTimeoutMs);
      earlyTimer.unref();
      session.once("close", () => clearTimeout(earlyTimer));
    }

    // The check must wait for this event. A socket that the SDK destroys in
    // its own "secureConnect" listener, which runs before the one of
    // `node:http2`, stops the process on a failed assertion in Node.
    session.once("connect", () => {
      clearTimeout(timer);
      connected = true;
      if (session.alpnProtocol === "h2") {
        onProtocol?.(origin, "h2");
      } else {
        http1Only(origin);
        session.destroy();
      }
    });
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
    session.unref();
    sessions.set(origin, entry);
    return entry;
  }

  function sessionFor(origin: string, early = false): Entry {
    const found = sessions.get(origin);
    if (found && !found.session.closed && !found.session.destroyed) return found;
    return connect(origin, early);
  }

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
  ): Promise<DirectResponse | "not-sent"> {
    return new Promise<DirectResponse | "not-sent">((resolve, reject) => {
      const signal = init.signal ?? undefined;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const entry = sessionFor(origin);
      const stream: ClientHttp2Stream = entry.session.request(headers, {
        endStream: init.body === undefined,
      });
      if (entry.inFlight++ === 0) entry.session.ref();
      const chunks: Buffer[] = [];
      let length = 0;
      let status = 0;
      let settled = false;
      let onAbort: (() => void) | undefined;
      const wait: Waiting = {
        seen: sweeps,
        expire: () => {
          fail(timeoutError(`${origin} sent no data for ${stallTimeoutMs} ms.`));
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
        else if (http1Origins.has(origin)) resolve("not-sent");
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
        // Node ends a stream with no error when its connection closes, or
        // when the server cancels it. Only the reset code tells such an end
        // from the end of a whole answer.
        if (status === 0 || stream.rstCode !== NGHTTP2_NO_ERROR) {
          fail(new Error(`${origin} closed the stream before its end (code ${stream.rstCode}).`));
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
      if (init.body !== undefined) stream.end(init.body);
    });
  }

  const takes = (url: string) =>
    url.startsWith("https://") && !http1Origins.has(splitUrl(url).origin);

  return {
    takes,
    send(url, init) {
      if (!takes(url)) return Promise.resolve("not-sent");
      const { origin, path } = splitUrl(url);
      return attempt(origin, requestHeaders(path, init), init, { refused: 0, closed: 0 });
    },
    open(origin) {
      if (!origin.startsWith("https://") || http1Origins.has(origin)) return false;
      sessionFor(origin, true);
      return true;
    },
  };
}
