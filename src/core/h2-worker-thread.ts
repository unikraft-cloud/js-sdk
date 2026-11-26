// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

// The program of the HTTP/2 worker. `scripts/generate-h2-worker.mjs` compiles
// this file and `h2.ts` into the string that `h2-worker.ts` gives to the
// worker.

import dns from "node:dns";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import { type MessagePort, parentPort, workerData } from "node:worker_threads";
import { CONNECT_TIMEOUT_MS, createDirectSender } from "./h2.js";
import type { FromWorker, ToWorker, WorkerConfig } from "./h2-worker.js";
import type { LookupAddress, LookupFunction } from "./transport.js";

const port = parentPort as MessagePort;
const { origin, ...timeouts } = workerData as WorkerConfig;
const post = (message: FromWorker, transfer: ArrayBuffer[] = []) =>
  port.postMessage(message, transfer);

let address: LookupAddress | undefined;
const lookup: LookupFunction = (hostname, options, callback) => {
  if (!address) dns.lookup(hostname, options, callback);
  else if (options.all) callback(null, [address]);
  else callback(null, address.address, address.family);
};

const sender = createDirectSender(
  { http2, tls, net },
  {
    ...timeouts,
    // The process does not wait for a worker, so a connection with no request
    // gets the same time as one with a request.
    earlyConnectTimeoutMs: timeouts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    cache: {
      lookup,
      forget: () => {
        address = undefined;
        post({ t: "forget" });
      },
    },
    onProtocol: (_origin, protocol) => post({ t: protocol === "h2" ? "up" : "http1" }),
  },
);

const cancels = new Map<number, AbortController>();

port.on("message", (m: ToWorker) => {
  if (m.t === "addr") {
    if (m.address) address = { address: m.address, family: m.family ?? 4 };
    sender.open(origin);
  } else if (m.t === "cancel") {
    cancels.get(m.id)?.abort();
  } else {
    const { id, path, cancellable, ...init } = m;
    const cancel = cancellable ? new AbortController() : undefined;
    if (cancel) cancels.set(id, cancel);
    sender
      .send(origin + path, { ...init, signal: cancel?.signal })
      .then(async (answer) => {
        if (answer === "not-sent") return post({ t: "not-sent", id });
        const body = await answer.arrayBuffer();
        post({ t: "res", id, status: answer.status, body }, [body]);
      })
      .catch((error: { message?: unknown; code?: string }) => {
        // The main thread rejected a cancelled request already.
        if (!cancel?.signal.aborted) {
          post({ t: "err", id, message: String(error?.message), code: error?.code });
        }
      })
      .finally(() => cancels.delete(id));
  }
});
