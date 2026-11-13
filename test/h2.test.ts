// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

import { spawn } from "node:child_process";
import {
  constants,
  createSecureServer,
  type Http2Session,
  type Http2Stream,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
} from "node:http2";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { connect as connectTcp, createServer as createTcpServer, type Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTransport,
  type LookupAddress,
  type Resolver,
  type Transport,
  type TransportDeps,
} from "../src/core/transport.js";
import { UnikraftCloud } from "../src/index.js";
import { cert, key } from "./fixtures/tls.js";

const loopback: LookupAddress[] = [{ address: "127.0.0.1", family: 4 }];

beforeEach(() => {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
    vi.stubEnv(name, undefined);
    vi.stubEnv(name.toLowerCase(), undefined);
  }
  // The certificate of the fixture is self-signed, so no CA can verify it.
  vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

interface Seen {
  method: string;
  path: string;
  version: string;
  authorization?: string;
  body: string;
}

type Handler = (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, index: number) => void;

const ok: Handler = (stream) => {
  stream.respond({ ":status": 200, "content-type": "application/json" });
  stream.end(JSON.stringify({ status: "success", op_time_us: 1 }));
};

const byPath: Handler = (stream, headers, index) => {
  if (headers[":path"] === "/missing") {
    stream.respond({ ":status": 404, "content-type": "application/json" });
    stream.end(JSON.stringify({ status: "error", message: "no such instance" }));
  } else if (headers[":path"] === "/bytes") {
    stream.respond({ ":status": 200, "content-type": "application/octet-stream" });
    stream.end(Buffer.from([0, 1, 255]));
  } else if (headers[":path"] === "/large") {
    stream.respond({ ":status": 200, "content-type": "application/json" });
    stream.end(JSON.stringify({ status: "success", data: "x".repeat(300_000) }));
  } else {
    ok(stream, headers, index);
  }
};

/**
 * An HTTPS server that answers HTTP/2, and HTTP/1.1 to a client that offers
 * only that. It records each request, each HTTP/2 session, and whether each
 * TLS connection resumed a session.
 */
async function listenH2(handler: Handler = ok, onSession?: (session: Http2Session) => void) {
  const seen: Seen[] = [];
  const resumed: boolean[] = [];
  const sessions: Http2Session[] = [];
  const server = createSecureServer({ key, cert, allowHTTP1: true });
  let index = 0;
  server.on("session", (session) => {
    sessions.push(session);
    onSession?.(session);
  });
  server.on("secureConnection", (socket: TLSSocket) => resumed.push(socket.isSessionReused()));
  server.on("stream", (stream, headers) => {
    stream.on("error", () => {});
    let body = "";
    stream.on("data", (chunk) => {
      body += chunk;
    });
    stream.on("end", () => {
      seen.push({
        method: headers[":method"] as string,
        path: headers[":path"] as string,
        version: "2.0",
        authorization: headers.authorization,
        body,
      });
    });
    handler(stream, headers, index++);
  });
  server.on("request", (request, response) => {
    if (request.httpVersion === "2.0") return;
    seen.push({
      method: request.method ?? "",
      path: request.url ?? "",
      version: request.httpVersion,
      body: "",
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "success", op_time_us: 1 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    seen,
    resumed,
    sessions,
    close: async () => {
      for (const session of sessions) session.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function directTransport(deps: TransportDeps = {}): Promise<Transport> {
  const transport = await createTransport(
    { proxyFromEnv: true, dnsCache: true, http2Direct: true },
    { resolve: async () => loopback, ...deps },
  );
  if (!transport?.direct) throw new Error("expected the direct HTTP/2 path");
  return transport;
}

function sendDirect(transport: Transport, url: string, signal?: AbortSignal) {
  const sent = transport.direct?.send(url, { method: "GET", headers: {}, signal });
  if (!sent) throw new Error(`the direct path did not take ${url}`);
  return sent;
}

/** A TCP server that accepts connections and never answers, so a TLS handshake never ends. */
async function listenSilent() {
  const held = new Set<Socket>();
  const server = createTcpServer((socket) => held.add(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const socket of held) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A TCP listener that takes no new connection: a child process listens with
 * a backlog of 1 and stops itself, and two connections fill its queue. The
 * kernel then drops the SYN of the next connect, which stays pending. Linux
 * only, because the size of the queue differs on other systems. Node.js reads
 * a backlog of 0 as its default, so 1 is the smallest.
 */
async function listenStopped() {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `require("node:net").createServer().listen({ port: 0, host: "127.0.0.1", backlog: 1 }, function () {
        process.stdout.write(this.address().port + "\\n", () => process.kill(process.pid, "SIGSTOP"));
      });`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const port = await new Promise<number>((resolve) =>
    child.stdout.once("data", (data) => resolve(Number(String(data)))),
  );
  const fillers = await Promise.all(
    [1, 2].map(
      () =>
        new Promise<Socket>((resolve) => {
          const socket = connectTcp(port, "127.0.0.1", () => resolve(socket));
        }),
    ),
  );
  return {
    port,
    close: async () => {
      for (const socket of fillers) socket.destroy();
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

describe("http2Direct", () => {
  it("sends the requests of a burst over one HTTP/2 session and reads every kind of answer", async () => {
    const server = await listenH2(byPath);
    const api = new UnikraftCloud({
      token: "t",
      baseUrl: `https://127.0.0.1:${server.port}`,
      http2Direct: true,
    }).api.platform.instances;

    try {
      await Promise.all(
        Array.from({ length: 50 }, (_, k) =>
          api.request({ method: "POST", path: "/v1/instances", query: { k }, body: { k } }),
        ),
      );
      await expect(api.request({ method: "GET", path: "/missing" })).rejects.toMatchObject({
        kind: "http",
        status: 404,
        message: "no such instance",
      });
      await expect(api.bytes({ method: "GET", path: "/bytes" })).resolves.toEqual(
        new Uint8Array([0, 1, 255]),
      );
      await expect(api.request({ method: "GET", path: "/large" })).resolves.toMatchObject({
        data: "x".repeat(300_000),
      });

      expect(server.sessions).toHaveLength(1);
      expect(server.seen.filter((s) => s.method === "POST")).toHaveLength(50);
      expect(server.seen[0]).toMatchObject({
        version: "2.0",
        authorization: "Bearer t",
        path: expect.stringMatching(/^\/v1\/instances\?k=\d+$/),
        body: expect.stringMatching(/^\{"k":\d+\}$/),
      });
    } finally {
      await server.close();
    }
  });

  it.each([
    {
      server: "refuses the first stream",
      handler: ((stream, headers, index) =>
        index === 0
          ? stream.close(constants.NGHTTP2_REFUSED_STREAM)
          : ok(stream, headers, index)) as Handler,
    },
    {
      // A GOAWAY that names stream 1 as the last one refuses streams 3 and 5.
      server: "sends a GOAWAY after the first stream",
      handler: ((stream, headers, index) =>
        index === 1
          ? stream.session?.goaway(constants.NGHTTP2_NO_ERROR, 1)
          : ok(stream, headers, index)) as Handler,
    },
    {
      // Each request gets a GOAWAY and two refusals, which is more than one
      // budget of two retries, so the GOAWAY must not use up the refusal budget.
      server: "sends a GOAWAY, and then refuses each request two times on the new session",
      handler: (() => {
        const streamsOf = new Map<unknown, number>();
        return ((stream, headers, index) => {
          const nth = streamsOf.get(stream.session) ?? 0;
          streamsOf.set(stream.session, nth + 1);
          // The first session sent a GOAWAY, so its streams need no answer.
          if (streamsOf.size === 1) return;
          if (nth < 6) stream.close(constants.NGHTTP2_REFUSED_STREAM);
          else ok(stream, headers, index);
        }) as Handler;
      })(),
      onSession: (session: Http2Session, nth: number) => {
        if (nth === 0) session.goaway(constants.NGHTTP2_NO_ERROR, 0);
      },
    },
  ])("sends a refused request again when the server $server", async ({ handler, onSession }) => {
    let sessionsSeen = 0;
    const server = await listenH2(handler, (session) => onSession?.(session, sessionsSeen++));
    const transport = await directTransport();
    const url = `https://api.metro.test:${server.port}/v1/instances`;

    try {
      const answers = await Promise.all([1, 2, 3].map(() => sendDirect(transport, url)));
      expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
    } finally {
      await server.close();
    }
  });

  it("opens a new session, which resumes the TLS session, after the server closes the idle one", async () => {
    const server = await listenH2();
    const transport = await directTransport();
    const url = `https://api.metro.test:${server.port}/`;

    try {
      await sendDirect(transport, url);
      const [first] = server.sessions;
      await new Promise<void>((resolve) => first?.close(resolve));
      await expect(sendDirect(transport, url)).resolves.toMatchObject({ status: 200 });

      expect(server.sessions).toHaveLength(2);
      expect(server.resumed).toEqual([false, true]);
    } finally {
      await server.close();
    }
  });

  it.each([
    { server: "answers only HTTP/1.1", http1: true },
    { server: "is reached through an http: base URL", http1: false },
  ])("sends the requests through undici when the server $server", async ({ http1 }) => {
    const server = http1
      ? createHttpsServer({ key, cert }, (_request, response) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: "success", op_time_us: 1 }));
        })
      : (await import("node:http")).createServer((_request, response) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: "success", op_time_us: 1 }));
        });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const api = new UnikraftCloud({
      token: "t",
      baseUrl: `${http1 ? "https" : "http"}://127.0.0.1:${port}`,
      http2Direct: true,
    }).api.platform.instances;

    try {
      for (let k = 0; k < 2; k++) {
        await expect(api.request({ method: "GET", path: "/" })).resolves.toEqual({
          status: "success",
          op_time_us: 1,
        });
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // A session that still connects must give up on its socket itself:
  // `destroy` on the session leaves a pending TCP connect alone.
  it.each([
    { stage: "the TLS handshake", server: listenSilent, lookup: "answers" },
    { stage: "the TCP connect", server: listenStopped, lookup: "answers" },
    { stage: "the address lookup", server: listenSilent, lookup: "never answers" },
  ])(
    "fails a connection that stalls in $stage, and resolves the host again",
    async ({ server, lookup }) => {
      const silent = await server();
      const resolve = vi.fn<Resolver>(() =>
        lookup === "answers" ? Promise.resolve(loopback) : new Promise(() => {}),
      );
      const transport = await directTransport({ resolve, direct: { connectTimeoutMs: 50 } });
      const url = `https://api.metro.test:${silent.port}/`;

      try {
        await expect(sendDirect(transport, url)).rejects.toMatchObject({ code: "ETIMEDOUT" });
        await expect(sendDirect(transport, url)).rejects.toMatchObject({ code: "ETIMEDOUT" });
        expect(resolve).toHaveBeenCalledTimes(2);
        // A connect that is left behind keeps the process alive.
        await vi.waitFor(() =>
          expect(process.getActiveResourcesInfo()).not.toContain("ConnectWrap"),
        );
      } finally {
        await silent.close();
      }
    },
  );

  it("gives up an early session that is still connecting, so that a later request opens a new one", async () => {
    const server = await listenH2();
    const resolve = vi
      .fn<Resolver>()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue(loopback);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const transport = await directTransport({ resolve, direct: { openTimeoutMs: 50 } });
    const origin = `https://api.metro.test:${server.port}`;

    try {
      transport.direct?.open(origin);
      await vi.advanceTimersByTimeAsync(50);
      vi.useRealTimers();
      await expect(sendDirect(transport, `${origin}/`)).resolves.toMatchObject({ status: 200 });
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
    }
  });

  it("fails a request whose answer does not come in time, and keeps the session for the next", async () => {
    const server = await listenH2((stream, headers, index) => {
      if (index > 0) ok(stream, headers, index);
    });
    const transport = await directTransport({ direct: { answerTimeoutMs: 50 } });
    const url = `https://api.metro.test:${server.port}/`;

    try {
      await expect(sendDirect(transport, url)).rejects.toMatchObject({ code: "ETIMEDOUT" });
      await expect(sendDirect(transport, url)).resolves.toMatchObject({ status: 200 });
      expect(server.sessions).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("rejects with the reason of an aborted signal and resets the stream", async () => {
    let reset: Promise<number> | undefined;
    const server = await listenH2((stream) => {
      reset = new Promise((resolve) =>
        (stream as Http2Stream).on("close", () => resolve(stream.rstCode)),
      );
    });
    const transport = await directTransport();
    const controller = new AbortController();
    const sent = sendDirect(transport, `https://api.metro.test:${server.port}/`, controller.signal);

    try {
      await vi.waitFor(() => expect(reset).toBeDefined());
      controller.abort(new Error("stop"));
      await expect(sent).rejects.toThrow("stop");
      await expect(reset).resolves.toBe(constants.NGHTTP2_CANCEL);
    } finally {
      await server.close();
    }
  });

  it.each([
    { when: "a proxy variable is set", env: { HTTPS_PROXY: "http://127.0.0.1:9" }, bun: false },
    { when: "the runtime is Bun", env: {}, bun: true },
  ])("is off when $when", async ({ env, bun }) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    if (bun) Object.defineProperty(process.versions, "bun", { value: "1.3.0", configurable: true });
    try {
      const transport = await createTransport({
        proxyFromEnv: true,
        dnsCache: true,
        http2Direct: true,
      });
      expect(transport).toBeDefined();
      expect(transport?.direct).toBeUndefined();
    } finally {
      if (bun) delete (process.versions as Record<string, string>).bun;
    }
  });
});

/**
 * Runs `body` in a new Node.js process that has the SDK sources loaded as
 * `UnikraftCloud`, and resolves with the exit code.
 */
function runChild(body: string): Promise<{ code: number | null; stderr: string }> {
  const index = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const hooks = fileURLToPath(new URL("./fixtures/ts-hooks.mjs", import.meta.url));
  const code = `import { UnikraftCloud } from ${JSON.stringify(index)};\n${body}`;
  const child = spawn(
    process.execPath,
    ["--no-warnings", "--import", hooks, "--input-type=module", "--eval", code],
    // A child that does not end gets killed, so that a failure reports an
    // exit code of null and not a timeout of the test. A pending TCP connect
    // that the SDK does not give up keeps the child alive for minutes, while
    // the kernel sends the connect again.
    { env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" }, timeout: 4000 },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

describe("preconnect", () => {
  it("opens the direct session when the client is made, and the first request uses it", async () => {
    const server = await listenH2();
    const ukc = new UnikraftCloud({
      token: "t",
      baseUrl: `https://127.0.0.1:${server.port}`,
      http2Direct: true,
      preconnect: true,
    });

    try {
      await vi.waitFor(() => expect(server.sessions).toHaveLength(1));
      await ukc.api.platform.instances.request({ method: "GET", path: "/" });
      expect(server.sessions).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("does not throw for a host that refuses the connection, and the request reports the failure", async () => {
    const silent = await listenSilent();
    await silent.close();
    const ukc = new UnikraftCloud({
      token: "t",
      baseUrl: `https://127.0.0.1:${silent.port}`,
      http2Direct: true,
      preconnect: true,
    });

    await expect(
      ukc.api.platform.instances.request({ method: "GET", path: "/" }),
    ).rejects.toMatchObject({ kind: "network", message: expect.stringContaining("ECONNREFUSED") });
  });

  // A refused port: a server that listened and closed again.
  async function listenClosed() {
    const server = await listenSilent();
    await server.close();
    return { port: server.port, close: async () => {} };
  }

  it.each([
    { client: "sends a request and returns", server: () => listenH2(), request: true },
    {
      client: "connects to a host that never ends the handshake",
      server: listenSilent,
      request: false,
    },
    { client: "connects to a port that refuses", server: listenClosed, request: false },
    { client: "connects to an address that never answers", server: listenStopped, request: false },
  ])(
    "lets the process exit by itself when the client $client",
    async ({ server: listen, request }) => {
      const server = await listen();
      const options = `{ token: "t", baseUrl: "https://127.0.0.1:${server.port}", http2Direct: true, preconnect: true }`;
      const body = request
        ? `const ukc = new UnikraftCloud(${options});
         await ukc.api.platform.instances.request({ method: "GET", path: "/" });`
        : `new UnikraftCloud(${options});`;

      try {
        await expect(runChild(body)).resolves.toEqual({ code: 0, stderr: "" });
      } finally {
        await server.close();
      }
    },
  );
});
