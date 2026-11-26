// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

import type { Worker } from "node:worker_threads";
import {
  type DirectInit,
  type DirectOptions,
  type DirectResponse,
  type DirectSender,
  splitUrl,
  toResponse,
} from "./h2.js";
import { WORKER_SOURCE } from "./h2-worker-source.js";
import type { CachedLookup } from "./transport.js";

export type ToWorker =
  | { t: "addr"; address?: string; family?: number }
  | {
      t: "req";
      id: number;
      path: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      cancellable?: boolean;
    }
  | { t: "cancel"; id: number };

export type FromWorker =
  | { t: "up" }
  | { t: "http1" }
  | { t: "forget" }
  | { t: "not-sent"; id: number }
  | { t: "res"; id: number; status: number; body: ArrayBuffer }
  | { t: "err"; id: number; message: string; code?: string };

export interface WorkerConfig extends Omit<DirectOptions, "cache" | "onProtocol"> {
  origin: string;
}

interface Pending {
  resolve: (response: DirectResponse | "not-sent") => void;
  reject: (error: unknown) => void;
}

interface WorkerEntry {
  worker: Worker;
  up: boolean;
  retired: boolean;
  pending: Map<number, Pending>;
}

export interface WorkerSenderOptions extends Omit<WorkerConfig, "origin"> {
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
    const host = new URL(origin).hostname.replace(/^\[(.*)\]$/, "$1");
    // The worker runs from a string with `eval: true`, not from a file. A file
    // next to this module is missing when a bundler packs the SDK, and has the
    // wrong extension when the SDK runs from its TypeScript sources. The worker
    // gets no `execArgv`, so it does not load a loader of the parent, for
    // example tsx, a second time.
    const worker = new WorkerClass(WORKER_SOURCE, {
      eval: true,
      execArgv: [],
      workerData: { origin, ...timeouts } satisfies WorkerConfig,
    });
    const entry: WorkerEntry = { worker, up: false, retired: false, pending: new Map() };
    workers.set(origin, entry);

    const retire = (settle: (pending: Pending) => void) => {
      if (entry.retired && entry.pending.size === 0) return;
      entry.retired = true;
      for (const pending of entry.pending.values()) settle(pending);
      entry.pending.clear();
    };
    const die = (error: unknown) => retire((pending) => pending.reject(error));
    worker.on("message", (m: FromWorker) => {
      if (m.t === "up") {
        entry.up = true;
      } else if (m.t === "http1") {
        retire((pending) => pending.resolve("not-sent"));
        worker.terminate().catch(() => {});
      } else if (m.t === "forget") {
        cache?.forget(host);
      } else {
        const pending = entry.pending.get(m.id);
        if (!pending) return;
        entry.pending.delete(m.id);
        if (entry.pending.size === 0) worker.unref();
        if (m.t === "res") pending.resolve(toResponse(m.status, Buffer.from(m.body)));
        else if (m.t === "not-sent") pending.resolve("not-sent");
        else pending.reject(Object.assign(new Error(m.message), m.code ? { code: m.code } : {}));
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

  function viaWorker(
    entry: WorkerEntry,
    path: string,
    init: DirectInit,
  ): Promise<DirectResponse | "not-sent"> {
    return new Promise<DirectResponse | "not-sent">((resolve, reject) => {
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
        path,
        method: init.method,
        headers: init.headers,
        ...(init.body !== undefined && { body: init.body }),
        ...(signal && { cancellable: true }),
      } satisfies ToWorker);
    });
  }

  return {
    takes: (url) => main.takes(url),
    send(url, init) {
      if (!url.startsWith("https://")) return Promise.resolve("not-sent");
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
