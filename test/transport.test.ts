// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

const send = (transport: Transport, url: string) =>
  transport.fetch(url, { dispatcher: transport.dispatcher } as RequestInit);

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
    { http2: undefined, allowH2: true },
    { http2: false, allowH2: false },
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

  it("leaves the requests to the global fetch when undici is not installed", async () => {
    const importUndici = () => Promise.reject(new Error("Cannot find package 'undici'"));

    await expect(
      createTransport({ proxyFromEnv: true, dnsCache: true }, { importUndici }),
    ).resolves.toBeUndefined();
  });
});

describe("UnikraftCloud", () => {
  it.each([
    { via: "undici by default", dnsCache: undefined, globalFetchCalls: 0 },
    { via: "the global fetch when dnsCache is false", dnsCache: false, globalFetchCalls: 1 },
  ])("sends a request through $via", async ({ dnsCache, globalFetchCalls }) => {
    const server = await listen();
    const globalFetch = vi.fn(globalThis.fetch);
    vi.stubGlobal("fetch", globalFetch);
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const ukc = new UnikraftCloud({ token: "t", baseUrl, dnsCache });

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
    { via: "undici", dnsCache: undefined },
    { via: "the global fetch", dnsCache: false },
  ])(
    "sends a request that follows another on the same connection, through $via",
    async ({ dnsCache }) => {
      const server = await listen({ keepAlive: true });
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const ukc = new UnikraftCloud({ token: "t", baseUrl, dnsCache });

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
