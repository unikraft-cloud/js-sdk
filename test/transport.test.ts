// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cachedLookup,
  createTransport,
  type LookupAddress,
  type LookupFunction,
  type Resolver,
} from "../src/core/transport.js";
import { UnikraftCloud } from "../src/index.js";

// Proxy variables from the developer's shell would change the route of these
// requests. undici reads `no_proxy` before `NO_PROXY`, so a `no_proxy` from
// the shell would also hide the `NO_PROXY` that a test sets.
beforeEach(() => {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
    vi.stubEnv(name, undefined);
    vi.stubEnv(name.toLowerCase(), undefined);
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const loopback: LookupAddress[] = [{ address: "127.0.0.1", family: 4 }];

function ask(lookup: LookupFunction, hostname: string, all = true): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all }, (error, ...answer) => (error ? reject(error) : resolve(answer)));
  });
}

async function listen(): Promise<{
  port: number;
  connections: () => number;
  close: () => Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
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
  it("sends a request through the proxy that HTTP_PROXY names", async () => {
    const server = await listen();
    const proxy = await listenProxy();
    vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${proxy.port}`);
    const transport = await createTransport({ proxyFromEnv: true });
    const url = `http://api.metro.test:${server.port}/`;

    try {
      const sent = transport?.proxy?.fetch(url, {
        dispatcher: transport.proxy.dispatcher,
      } as RequestInit);
      await expect(sent).resolves.toMatchObject({ status: 200 });
      expect(proxy.requests).toEqual([url]);
    } finally {
      await proxy.close();
      await server.close();
    }
  });

  it.each([
    { when: "no proxy variable is set and http2Direct is off", env: {}, deno: false },
    {
      when: "a proxy variable is set and undici is not installed",
      env: { HTTP_PROXY: "http://127.0.0.1:9" },
      deno: false,
    },
    { when: "the runtime is Deno", env: { HTTP_PROXY: "http://127.0.0.1:9" }, deno: true },
  ])("leaves the requests to the global fetch when $when", async ({ env, deno }) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    if (deno) vi.stubGlobal("Deno", {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const importUndici = () => Promise.reject(new Error("Cannot find package 'undici'"));

    await expect(
      createTransport({ proxyFromEnv: true }, { importUndici }),
    ).resolves.toBeUndefined();
  });
});

describe("UnikraftCloud", () => {
  it("does not hold the creates of a burst that goes through fetch", async () => {
    // The pace takes `setTimeout` when its module loads, so the fake clock
    // must come before the import. A create that waits for the pace then
    // never starts, and the test ends on its timeout.
    vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
    vi.resetModules();
    const { UnikraftCloud: Fresh } = await import("../src/index.js");
    const globalFetch = vi.fn(async () => Response.json({ status: "success", op_time_us: 1 }));
    vi.stubGlobal("fetch", globalFetch);
    const api = new Fresh({ token: "t", metro: "fra" }).api.platform.instances;

    await Promise.all(
      Array.from({ length: 10 }, () => api.request({ method: "POST", path: "/v1/instances" })),
    );
    expect(globalFetch).toHaveBeenCalledTimes(10);
  });

  it("reads a JSON answer, an error answer and a byte body through the global fetch", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/missing") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "error", message: "no such instance" }));
      } else if (request.url === "/bytes") {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(Buffer.from([0, 1, 255]));
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "success", op_time_us: 1 }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const api = new UnikraftCloud({ token: "t", baseUrl: `http://127.0.0.1:${port}` }).api.platform
      .instances;

    try {
      await expect(api.request({ method: "GET", path: "/ok" })).resolves.toEqual({
        status: "success",
        op_time_us: 1,
      });
      await expect(api.request({ method: "GET", path: "/missing" })).rejects.toMatchObject({
        kind: "http",
        status: 404,
        message: "no such instance",
      });
      await expect(api.bytes({ method: "GET", path: "/bytes" })).resolves.toEqual(
        new Uint8Array([0, 1, 255]),
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // A test that mocks the global fetch (`vi.stubGlobal`, MSW, nock) must see
  // the requests of a client that sets no `fetch`.
  it("sends a request through the global fetch that is set when the client is made", async () => {
    const globalFetch = vi.fn(async () => Response.json({ status: "success", op_time_us: 1 }));
    vi.stubGlobal("fetch", globalFetch);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra" });

    await expect(ukc.api.platform.instances.getInstances({})).resolves.toEqual({
      status: "success",
      op_time_us: 1,
    });
    expect(globalFetch).toHaveBeenCalledOnce();
  });

  it("sends a request that follows another on the same connection", async () => {
    const server = await listen();
    const ukc = new UnikraftCloud({ token: "t", baseUrl: `http://127.0.0.1:${server.port}` });

    try {
      await ukc.api.platform.instances.getInstances({});
      await ukc.api.platform.instances.getInstances({});
      expect(server.connections()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("answers while fake timers that started before the import hold setImmediate", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { UnikraftCloud: Fresh } = await import("../src/index.js");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: "success", op_time_us: 1 })),
    );
    const ukc = new Fresh({ token: "t", metro: "fra" });

    await expect(ukc.api.platform.instances.getInstances({})).resolves.toEqual({
      status: "success",
      op_time_us: 1,
    });
  });
});
