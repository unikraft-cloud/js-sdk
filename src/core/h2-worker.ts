// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

import type { Worker } from "node:worker_threads";
import {
  CONNECT_TIMEOUT_MS,
  type DirectInit,
  type DirectOptions,
  type DirectResponse,
  type DirectSender,
  Http1Host,
  IDLE_TIMEOUT_MS,
  requestHeaders,
  STALL_TIMEOUT_MS,
  splitUrl,
  toResponse,
} from "./h2.js";
import type { CachedLookup } from "./transport.js";

type ToWorker =
  | { t: "addr"; address?: string; family?: number }
  | { t: "req"; id: number; h: Record<string, string>; b?: string }
  | { t: "cancel"; id: number };

type FromWorker =
  | { t: "up" }
  | { t: "http1" }
  | { t: "forget" }
  | { t: "res"; id: number; s: number; b: ArrayBuffer }
  | { t: "err"; id: number; m: string; c?: string; http1?: boolean };

interface WorkerConfig {
  origin: string;
  host: string;
  port: number;
  connectTimeoutMs: number;
  stallTimeoutMs: number;
  idleTimeoutMs: number;
}

// The worker runs from this source with `eval: true`, not from a file. A file
// next to this module is missing when a bundler packs the SDK, and has the
// wrong extension when the SDK runs from its TypeScript sources. The worker
// gets no `execArgv`, so it does not load a loader of the parent, for example
// tsx, a second time.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const http2 = require("node:http2");
const tls = require("node:tls");
const net = require("node:net");
const dns = require("node:dns");
const { NGHTTP2_CANCEL, NGHTTP2_NO_ERROR, NGHTTP2_REFUSED_STREAM } = http2.constants;
const { origin, host, port, connectTimeoutMs, stallTimeoutMs, idleTimeoutMs } = workerData;
const MAX_RETRIES = 2;
const post = (message, transfer) => parentPort.postMessage(message, transfer);

let address;
let session;
let tlsTicket;
let inFlight = 0;
let http1 = false;
const streams = new Map();

function lookup(hostname, options, callback) {
  if (!address) return dns.lookup(hostname, options, callback);
  if (options.all) callback(null, [address]);
  else callback(null, address.address, address.family);
}

function timeoutError(message) {
  return Object.assign(new Error(message), { code: "ETIMEDOUT" });
}

function sessionError(error) {
  return error && error.code === "ERR_HTTP2_STREAM_CANCEL" && error.cause instanceof Error
    ? error.cause
    : error;
}

function connect() {
  let connected = false;
  let socket;
  const s = http2.connect(origin, {
    createConnection: () => {
      socket = tls.connect({
        host,
        port,
        ALPNProtocols: ["h2", "http/1.1"],
        ...(net.isIP(host) === 0 ? { servername: host } : {}),
        lookup,
        ...(tlsTicket ? { session: tlsTicket } : {}),
      });
      socket.on("session", (ticket) => { tlsTicket = ticket; });
      socket.once("error", (error) => { if (!connected) failedConnect(error); });
      return socket;
    },
  });
  const drop = () => { if (session === s) session = undefined; };
  const failedConnect = (error) => {
    drop();
    if (error && error.code === "ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL") {
      http1 = true;
      post({ t: "http1" });
    } else {
      address = undefined;
      post({ t: "forget" });
    }
  };
  const timer = setTimeout(() => {
    const error = timeoutError("The connection to " + origin + " did not open in " + connectTimeoutMs + " ms.");
    failedConnect(error);
    // destroy() on a session that still connects leaves its socket alone.
    if (socket) socket.destroy(error);
    s.destroy(error);
  }, connectTimeoutMs);
  s.once("connect", () => {
    clearTimeout(timer);
    connected = true;
    if (s.alpnProtocol !== "h2") {
      http1 = true;
      post({ t: "http1" });
      s.destroy();
      return;
    }
    post({ t: "up" });
  });
  s.on("error", () => { clearTimeout(timer); drop(); });
  s.on("close", () => { clearTimeout(timer); drop(); });
  s.on("goaway", drop);
  const onIdle = () => {
    if (inFlight === 0) s.close();
    else s.setTimeout(idleTimeoutMs, onIdle);
  };
  s.setTimeout(idleTimeoutMs, onIdle);
  session = s;
  return s;
}

function retry(s, retries) {
  if (s.closed || s.destroyed) {
    return retries.closed < MAX_RETRIES ? { refused: retries.refused, closed: retries.closed + 1 } : undefined;
  }
  return retries.refused < MAX_RETRIES ? { refused: retries.refused + 1, closed: retries.closed } : undefined;
}

function attempt(id, headers, body, retries) {
  if (http1) {
    post({ t: "err", id, m: origin + " does not answer HTTP/2.", http1: true });
    return;
  }
  const s = session && !session.closed && !session.destroyed ? session : connect();
  let stream;
  try {
    stream = s.request(headers, { endStream: body === undefined });
  } catch (error) {
    post({ t: "err", id, m: String(error.message), c: error.code });
    return;
  }
  inFlight++;
  streams.set(id, stream);
  const chunks = [];
  let length = 0;
  let status = 0;
  let settled = false;
  const settle = () => {
    if (settled) return false;
    settled = true;
    inFlight--;
    if (streams.get(id) === stream) streams.delete(id);
    return true;
  };
  const fail = (error) => {
    if (!settle()) return;
    if (http1) post({ t: "err", id, m: origin + " does not answer HTTP/2.", http1: true });
    else {
      const next = stream.rstCode === NGHTTP2_REFUSED_STREAM ? retry(s, retries) : undefined;
      if (next) return attempt(id, headers, body, next);
      const cause = sessionError(error);
      post({ t: "err", id, m: String(cause && cause.message), c: cause && cause.code });
    }
  };
  stream.setTimeout(stallTimeoutMs, () => {
    fail(timeoutError(origin + " sent no data for " + stallTimeoutMs + " ms."));
    stream.close(NGHTTP2_CANCEL);
  });
  stream.on("response", (h) => { status = Number(h[":status"]); });
  stream.on("data", (chunk) => { chunks.push(chunk); length += chunk.length; });
  stream.on("end", () => {
    if (status === 0 || stream.rstCode !== NGHTTP2_NO_ERROR) {
      return fail(new Error(origin + " closed the stream before its end (code " + stream.rstCode + ")."));
    }
    if (!settle()) return;
    // The chunks can be views of a shared pool, so they go into one buffer of
    // their own, which the post then transfers without a copy.
    const out = new ArrayBuffer(length);
    const view = new Uint8Array(out);
    let at = 0;
    for (const chunk of chunks) { view.set(chunk, at); at += chunk.length; }
    post({ t: "res", id, s: status, b: out }, [out]);
  });
  stream.on("error", fail);
  if (body !== undefined) stream.end(body);
}

parentPort.on("message", (m) => {
  if (m.t === "addr") {
    if (m.address) address = { address: m.address, family: m.family || 4 };
    if (!session) connect();
  } else if (m.t === "req") {
    attempt(m.id, m.h, m.b, { refused: 0, closed: 0 });
  } else if (m.t === "cancel") {
    const stream = streams.get(m.id);
    streams.delete(m.id);
    if (stream) stream.close(NGHTTP2_CANCEL);
  }
});
`;

interface Pending {
  resolve: (response: DirectResponse) => void;
  reject: (error: unknown) => void;
}

interface WorkerEntry {
  worker: Worker;
  up: boolean;
  retired: boolean;
  pending: Map<number, Pending>;
}

export interface WorkerSenderOptions extends Omit<DirectOptions, "cache"> {
  cache?: CachedLookup;
}

export function createWorkerSender(
  main: DirectSender,
  WorkerClass: typeof Worker,
  { cache, ...timeouts }: WorkerSenderOptions = {},
): DirectSender {
  const workers = new Map<string, WorkerEntry | undefined>();
  let nextId = 1;

  function entryFor(origin: string): WorkerEntry | undefined {
    if (workers.has(origin)) return workers.get(origin);
    try {
      return start(origin);
    } catch {
      workers.set(origin, undefined);
      return undefined;
    }
  }

  function start(origin: string): WorkerEntry {
    const { hostname, port } = new URL(origin);
    const host = hostname.replace(/^\[(.*)\]$/, "$1");
    const config: WorkerConfig = {
      origin,
      host,
      port: Number(port) || 443,
      connectTimeoutMs: timeouts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
      stallTimeoutMs: timeouts.stallTimeoutMs ?? STALL_TIMEOUT_MS,
      idleTimeoutMs: timeouts.idleTimeoutMs ?? IDLE_TIMEOUT_MS,
    };
    const worker = new WorkerClass(WORKER_SOURCE, { eval: true, execArgv: [], workerData: config });
    const entry: WorkerEntry = { worker, up: false, retired: false, pending: new Map() };
    workers.set(origin, entry);

    const die = (error: unknown) => {
      if (entry.retired && entry.pending.size === 0) return;
      entry.retired = true;
      for (const pending of entry.pending.values()) pending.reject(error);
      entry.pending.clear();
    };
    worker.on("message", (m: FromWorker) => {
      if (m.t === "up") {
        entry.up = true;
      } else if (m.t === "http1") {
        die(new Http1Host(origin));
        worker.terminate().catch(() => {});
      } else if (m.t === "forget") {
        cache?.forget(host);
      } else {
        const pending = entry.pending.get(m.id);
        if (!pending) return;
        entry.pending.delete(m.id);
        if (entry.pending.size === 0) worker.unref();
        if (m.t === "res") pending.resolve(toResponse(m.s, Buffer.from(m.b)));
        else if (m.http1) pending.reject(new Http1Host(origin));
        else pending.reject(Object.assign(new Error(m.m), m.c ? { code: m.c } : {}));
      }
    });
    worker.on("error", die);
    worker.on("exit", (code) =>
      die(new Error(`The HTTP/2 worker of the SDK stopped (exit code ${code}).`)),
    );
    // The call must come after the "message" listener, because Node refs the
    // port of the worker again when a "message" listener is added.
    worker.unref();

    const post = (message: ToWorker) => worker.postMessage(message);
    if (cache) {
      cache.lookup(host, {}, (error, address, family) => {
        post(
          !error && typeof address === "string" ? { t: "addr", address, family } : { t: "addr" },
        );
      });
    } else {
      post({ t: "addr" });
    }
    return entry;
  }

  function viaWorker(entry: WorkerEntry, path: string, init: DirectInit): Promise<DirectResponse> {
    return new Promise<DirectResponse>((resolve, reject) => {
      const signal = init.signal ?? undefined;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const id = nextId++;
      let onAbort: (() => void) | undefined;
      const done = () => {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      };
      if (signal) {
        onAbort = () => {
          if (!entry.pending.delete(id)) return;
          if (entry.pending.size === 0) entry.worker.unref();
          entry.worker.postMessage({ t: "cancel", id } satisfies ToWorker);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      if (entry.pending.size === 0) entry.worker.ref();
      entry.pending.set(id, {
        resolve: (response) => {
          done();
          resolve(response);
        },
        reject: (error) => {
          done();
          reject(error);
        },
      });
      entry.worker.postMessage({
        t: "req",
        id,
        h: requestHeaders(path, init),
        ...(init.body !== undefined && { b: init.body }),
      } satisfies ToWorker);
    });
  }

  return {
    takes: (url) => main.takes(url),
    send(url, init) {
      if (!url.startsWith("https://")) return undefined;
      const { origin, path } = splitUrl(url);
      const entry = entryFor(origin);
      if (!entry || entry.retired || !entry.up) return main.send(url, init);
      return viaWorker(entry, path, init);
    },
    open(origin) {
      if (!origin.startsWith("https://")) return false;
      entryFor(origin);
      return true;
    },
  };
}
