// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

import { createServer, request as httpRequest } from "node:http";
import { createSecureServer, type ServerHttp2Session } from "node:http2";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cachedLookup,
  createTransport,
  type LookupAddress,
  type LookupFunction,
  type Resolver,
  type Transport,
  type TransportDeps,
  type TransportOptions,
} from "../src/core/transport.js";
import { UnikraftCloud } from "../src/index.js";
import { cert, key } from "./fixtures/tls.js";

// A proxy variable from the developer's shell would send these requests to
// the proxy, which does not resolve them through the cache.
beforeEach(() => {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    vi.stubEnv(name, undefined);
    vi.stubEnv(name.toLowerCase(), undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const loopback: LookupAddress[] = [{ address: "127.0.0.1", family: 4 }];

function ask(lookup: LookupFunction, hostname: string, all = true): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all }, (error, ...answer) => (error ? reject(error) : resolve(answer)));
  });
}

async function listen({ keepAlive = false } = {}): Promise<{
  port: number;
  connections: () => number;
  close: () => Promise<void>;
}> {
  const server = createServer((_request, response) => {
    // Without keep-alive, each request opens a new connection, and each new
    // connection looks up the host.
    response.writeHead(200, {
      "content-type": "application/json",
      ...(!keepAlive && { connection: "close" }),
    });
    response.end(JSON.stringify({ status: "success", op_time_us: 1 }));
  });
  let connections = 0;
  server.on("connection", () => connections++);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    connections: () => connections,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function directTransport(
  deps: TransportDeps = {},
  options: Partial<TransportOptions> = {},
): Promise<Transport> {
  const transport = await createTransport({ proxyFromEnv: true, dnsCache: true, ...options }, deps);
  if (!transport) throw new Error("expected the undici transport");
  return transport;
}

// V8 gives `gc()` only behind a flag. A new context sees a flag set at run time.
setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

/** An HTTPS server that records, per request, whether its connection resumed a TLS session. */
async function listenTls(): Promise<{
  port: number;
  resumed: boolean[];
  close: () => Promise<void>;
}> {
  const resumed: boolean[] = [];
  const server = createTlsServer({ key, cert }, (request, response) => {
    resumed.push((request.socket as TLSSocket).isSessionReused());
    response.writeHead(200, { "content-type": "application/json", connection: "close" });
    response.end(JSON.stringify({ status: "success", op_time_us: 1 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    resumed,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const send = (transport: Transport, url: string) =>
  transport.fetch(url, { dispatcher: transport.dispatcher } as RequestInit);

/**
 * A forward proxy for plain HTTP: it repeats each request to the port in its
 * absolute URL, on the loopback, because the test hosts resolve nowhere.
 */
async function listenProxy(): Promise<{
  port: number;
  requests: string[];
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "");
    requests.push(url.href);
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: url.port,
        path: url.pathname + url.search,
        method: request.method,
        headers: request.headers,
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    request.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("cachedLookup", () => {
  it.each([
    { all: true, answer: [loopback] },
    { all: false, answer: ["127.0.0.1", 4] },
  ])("answers in the form net.connect asks for (all: $all)", async ({ all, answer }) => {
    const { lookup } = cachedLookup(async () => loopback);

    await expect(ask(lookup, "api.metro.test", all)).resolves.toEqual(answer);
  });

  it("resolves the host again once the time to live runs out", async () => {
    let time = 0;
    const resolve = vi.fn<Resolver>(async () => loopback);
    const { lookup } = cachedLookup(resolve, { ttlMs: 1000, now: () => time });

    await ask(lookup, "api.metro.test");
    time = 999;
    await ask(lookup, "api.metro.test");
    expect(resolve).toHaveBeenCalledTimes(1);

    time = 1000;
    await ask(lookup, "api.metro.test");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("resolves a miss through dns.lookup when given no resolver", async () => {
    const { lookup } = cachedLookup();

    await expect(ask(lookup, "127.0.0.1")).resolves.toEqual([loopback]);
  });

  it("does not keep a failed answer", async () => {
    const resolve = vi
      .fn<Resolver>()
      .mockRejectedValueOnce(new Error("getaddrinfo EAI_AGAIN api.metro.test"))
      .mockResolvedValue(loopback);
    const { lookup } = cachedLookup(resolve);

    await expect(ask(lookup, "api.metro.test")).rejects.toThrow(/EAI_AGAIN/);
    await expect(ask(lookup, "api.metro.test")).resolves.toEqual([loopback]);
  });
});

describe("createTransport", () => {
  it("resolves a host once for parallel requests to it", async () => {
    const server = await listen();
    const resolve = vi.fn<Resolver>(async () => loopback);
    const transport = await directTransport({ resolve });

    try {
      const responses = await Promise.all(
        Array.from({ length: 20 }, () => send(transport, `http://api.metro.test:${server.port}/`)),
      );

      expect(responses.map((response) => response.status)).toEqual(Array(20).fill(200));
      expect(resolve).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("resolves the host again after a connection to it fails", async () => {
    const server = await listen();
    await server.close();
    const resolve = vi.fn<Resolver>(async () => loopback);
    const transport = await directTransport({ resolve });
    const url = `http://api.metro.test:${server.port}/`;

    await expect(send(transport, url)).rejects.toMatchObject({ cause: { code: "ECONNREFUSED" } });
    await expect(send(transport, url)).rejects.toMatchObject({ cause: { code: "ECONNREFUSED" } });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("opens no more than maxConnections connections to a host", async () => {
    const server = await listen({ keepAlive: true });
    const transport = await directTransport({}, { maxConnections: 2 });

    try {
      const responses = await Promise.all(
        Array.from({ length: 20 }, () => send(transport, `http://127.0.0.1:${server.port}/`)),
      );

      expect(responses.map((response) => response.status)).toEqual(Array(20).fill(200));
      expect(server.connections()).toBe(2);
    } finally {
      await server.close();
    }
  });

  it.each([
    { http2: undefined, allowH2: false },
    { http2: true, allowH2: true },
  ])(
    "passes allowH2: $allowH2 to the connector when http2 is $http2",
    async ({ http2, allowH2 }) => {
      const buildConnector = vi.fn(() => () => undefined);
      const importUndici = async () => ({
        buildConnector,
        fetch: globalThis.fetch,
        Agent: class {},
      });

      await createTransport({ proxyFromEnv: false, dnsCache: true, http2 }, { importUndici });

      expect(buildConnector).toHaveBeenCalledWith(expect.objectContaining({ allowH2 }));
    },
  );

  it("resumes the TLS session of a host after a garbage collection", async () => {
    // The certificate of the fixture is self-signed, so no CA can verify it.
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    const server = await listenTls();
    const transport = await directTransport({ resolve: async () => loopback });
    const url = `https://api.metro.test:${server.port}/`;

    try {
      await (await send(transport, url)).arrayBuffer();
      collectGarbage();
      await (await send(transport, url)).arrayBuffer();

      expect(server.resumed).toEqual([false, true]);
    } finally {
      await server.close();
    }
  });

  it("reports a host as multiplexed after an HTTP/2 connection to it", async () => {
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    const server = createSecureServer({ key, cert }, (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "success", op_time_us: 1 }));
    });
    const sessions = new Set<ServerHttp2Session>();
    server.on("session", (session) => sessions.add(session));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const transport = await directTransport({ resolve: async () => loopback }, { http2: true });

    try {
      expect(transport.multiplexes("api.metro.test")).toBe(false);
      await (await send(transport, `https://api.metro.test:${port}/`)).arrayBuffer();
      expect(transport.multiplexes("api.metro.test")).toBe(true);
    } finally {
      for (const session of sessions) session.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("sends a request through the proxy that HTTP_PROXY names", async () => {
    const server = await listen();
    const proxy = await listenProxy();
    vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${proxy.port}`);
    const resolve = vi.fn<Resolver>(async () => loopback);
    const transport = await directTransport({ resolve });
    const url = `http://api.metro.test:${server.port}/`;

    try {
      expect(transport.proxied).toBe(true);
      await expect(send(transport, url)).resolves.toMatchObject({ status: 200 });
      expect(proxy.requests).toEqual([url]);
      // The proxy resolves the host, so the cache sees nothing.
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      await proxy.close();
      await server.close();
    }
  });

  it("sends a request to a host in NO_PROXY through the cached direct connector", async () => {
    const server = await listen();
    const proxy = await listenProxy();
    vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${proxy.port}`);
    vi.stubEnv("NO_PROXY", "api.metro.test");
    const resolve = vi.fn<Resolver>(async () => loopback);
    const transport = await directTransport({ resolve });
    const url = `http://api.metro.test:${server.port}/`;

    try {
      expect(transport.proxied).toBe(true);
      await Promise.all([send(transport, url), send(transport, url)]);
      expect(proxy.requests).toEqual([]);
      expect(server.connections()).toBe(2);
      expect(resolve).toHaveBeenCalledOnce();
    } finally {
      await proxy.close();
      await server.close();
    }
  });

  it.each([
    {
      when: "undici is not installed",
      importUndici: () => Promise.reject(new Error("Cannot find package 'undici'")),
      deno: false,
    },
    { when: "the runtime is Deno", importUndici: () => import("undici"), deno: true },
  ])("leaves the requests to the global fetch when $when", async ({ importUndici, deno }) => {
    if (deno) vi.stubGlobal("Deno", {});

    await expect(
      createTransport({ proxyFromEnv: true, dnsCache: true }, { importUndici }),
    ).resolves.toBeUndefined();
  });
});

describe("UnikraftCloud", () => {
  it("answers through a custom fetch while fake timers hold setImmediate", async () => {
    // Fake timers that come before the import replace the `setImmediate` the
    // module takes, so a request through the SDK's own transport would wait
    // for the clock. A caller's own fetch must not.
    vi.useFakeTimers();
    vi.resetModules();
    try {
      const { UnikraftCloud: Fresh } = await import("../src/index.js");
      const fetch = vi.fn(async () => Response.json({ status: "success", op_time_us: 1 }));
      const ukc = new Fresh({ token: "t", metro: "fra", fetch });

      await expect(ukc.api.platform.instances.getInstances({})).resolves.toEqual({
        status: "success",
        op_time_us: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { via: "undici by default", config: {}, globalFetchCalls: 0 },
    { via: "undici when dnsCache is false", config: { dnsCache: false }, globalFetchCalls: 0 },
    {
      via: "the global fetch when globalFetch is set",
      config: { globalFetch: true },
      globalFetchCalls: 1,
    },
  ])("sends a request through $via", async ({ config, globalFetchCalls }) => {
    const server = await listen();
    const globalFetch = vi.fn(globalThis.fetch);
    vi.stubGlobal("fetch", globalFetch);
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const ukc = new UnikraftCloud({ token: "t", baseUrl, ...config });

    try {
      await expect(ukc.api.platform.instances.getInstances({})).resolves.toEqual({
        status: "success",
        op_time_us: 1,
      });
      expect(globalFetch).toHaveBeenCalledTimes(globalFetchCalls);
    } finally {
      await server.close();
    }
  });

  it.each([
    { via: "undici", globalFetch: undefined },
    { via: "the global fetch", globalFetch: true },
  ])(
    "sends a request that follows another on the same connection, through $via",
    async ({ globalFetch }) => {
      const server = await listen({ keepAlive: true });
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const ukc = new UnikraftCloud({ token: "t", baseUrl, globalFetch });

      try {
        await ukc.api.platform.instances.getInstances({});
        await ukc.api.platform.instances.getInstances({});
        expect(server.connections()).toBe(1);
      } finally {
        await server.close();
      }
    },
  );
});
