// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// Tests for the Sandbox client, in the `fetch`-mocking style of
// `client.test.ts`. They live here rather than there because that file is
// already long; extend this one rather than starting a third.

import type { Transport } from "@unikraft/cloud-plugin-sandbox-api";
import { expect, expectTypeOf, onTestFinished, test, vi } from "vitest";
import type { ApiClient } from "../src/core/http.js";
import { Sandbox, UnikraftCloud, UnikraftCloudError } from "../src/index.js";
import {
  DEFAULT_AUTOKILL_MS,
  DEFAULT_BOOT_TIMEOUT_S,
  DEFAULT_IMAGE,
  DEFAULT_PLUGIN_IMAGE,
  MAX_WAIT_SLICE_S,
} from "../src/resources/sandboxes/options.js";
import { nextWait, READ_EVERY_BYTES } from "../src/resources/sandboxes/output.js";

function json(data: unknown) {
  return new Response(JSON.stringify({ status: "success", data, op_time_us: 1 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mock(extra?: (url: string, init: any) => Response | undefined) {
  const calls: Array<{ url: string; method: string; body: any; headers: any }> = [];
  const fetchImpl = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers,
    });
    const hit = extra?.(url, init);
    if (hit) return hit;
    if (url.includes("/plugins/")) {
      if (url.endsWith("/commands") && init.method === "POST") return json({ uuid: "c1" });
      if (url.endsWith("/commands")) return json({ commands: [] });
      // The plugin answers 408 when `timeout_s` elapses. A test that waits
      // needs the clock to move with it, which `fakePlugin` does; this answer
      // alone makes `Command.wait` ask again at once.
      if (url.endsWith("/wait_timeout")) return error(408, "Timed out");
      if (url.includes("/commands/c1") && init.method === "DELETE") return json(null);
      if (url.endsWith("/commands/c1"))
        return json({ uuid: "c1", cmdline: "x", cwd: null, env: null, exitcode: null });
      if (url.endsWith("/logs"))
        return json({ stdout: "", stderr: "", stdout_available: 0, stderr_available: 0 });
    }
    if (url.includes("controlplane.unikraft.cloud")) {
      return json({
        metros: [{ iata_code: "fra", endpoint: "https://api.fra-2.internal.example" }],
      });
    }
    return json({
      instances: [{ uuid: "u1", state: "running", plugins: [{ name: "sandbox", image: "r" }] }],
    });
  }) as any;
  return { calls, fetchImpl };
}

function error(status: number, message: string) {
  return new Response(JSON.stringify({ status: "error", message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A sandbox plugin that runs one command, `c1`, which exits `exitsAfterS`
 * seconds after it starts, on the fake clock. A request that holds the plugin
 * moves the clock forward by the time the plugin would have held it, so a wait
 * costs the time it asks for and no more.
 *
 * `rom: "ignores"` is a plugin from before `req_timeout_s`, which drops the
 * keys it does not know and starts the command at once.
 */
function fakePlugin({
  exitsAfterS,
  rom = "blocks",
}: {
  exitsAfterS: number;
  rom?: "blocks" | "ignores";
}) {
  let exitsAt: number | undefined;
  const exited = () => exitsAt !== undefined && Date.now() >= exitsAt;
  const hold = (seconds: number) => {
    const until = Date.now() + seconds * 1000;
    vi.setSystemTime(exitsAt === undefined ? until : Math.min(until, exitsAt));
  };
  const state = () => ({
    uuid: "c1",
    cmdline: "x",
    cwd: null,
    env: null,
    pty: false,
    duration_ms: 1,
    exitcode: exited() ? 0 : null,
  });
  const logs = () => ({ stdout: "b3V0", stderr: "", stdout_available: 3, stderr_available: 0 });

  return mock((url, init) => {
    if (!url.includes("/plugins/")) return undefined;
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (url.endsWith("/commands") && init.method === "POST") {
      exitsAt = Date.now() + exitsAfterS * 1000;
      if (body.req_timeout_s === undefined || rom === "ignores") return json(state());
      hold(body.req_timeout_s);
      return json({ ...state(), logs: logs() });
    }
    if (url.endsWith("/wait_timeout")) {
      hold(body.timeout_s);
      return exited() ? json(null) : error(408, "Timed out");
    }
    // A plugin before 1.3.0 holds the plain route until the command exits and
    // reads no body, so a slice sent there does not come back in time.
    if (url.endsWith("/wait")) {
      if (exitsAt !== undefined) vi.setSystemTime(exitsAt);
      return json(null);
    }
    if (url.endsWith("/logs")) return json(logs());
    if (url.endsWith("/commands/c1") && init.method === "GET") return json(state());
    return undefined;
  });
}

/** The bytes of a stream whose byte `i` is a letter, so that a read from any offset decodes alone. */
const letters = (from: number, to: number) =>
  Uint8Array.from({ length: to - from }, (_, i) => 97 + ((from + i) % 26));

/**
 * A sandbox plugin from 1.4.0 on that runs one command, `c1`. The command
 * writes `bytes` bytes to `stream` at `bytesPerS` on the fake clock, and exits
 * when it has written them all. The other stream stays empty. A request that
 * holds the plugin moves the clock as `fakePlugin` does.
 *
 * Unread output stops at `ceiling`: the command then writes nothing more until
 * a release. A finite `page` stands for a log on a volume, so no ceiling
 * applies there, and a JSON read sends at most one page. A raw read sends one
 * page too while the command runs, and the rest at once after it exits.
 *
 * `gone()` says whether the record is gone, through `forget` or a delete.
 */
function releasingPlugin({
  bytes,
  bytesPerS,
  ceiling = Number.POSITIVE_INFINITY,
  page = Number.POSITIVE_INFINITY,
  stream = "stdout",
}: {
  bytes: number;
  bytesPerS: number;
  ceiling?: number;
  page?: number;
  stream?: "stdout" | "stderr";
}) {
  let written = 0;
  let released = 0;
  let exited = false;
  let gone = false;
  const hold = (seconds: number) => {
    if (exited) return;
    const now = Date.now();
    const room = Math.min(bytes, released + ceiling) - written;
    const wrote = Math.min(room, Math.floor(bytesPerS * seconds));
    written += wrote;
    exited = written === bytes;
    vi.setSystemTime(exited ? now + (wrote / bytesPerS) * 1000 : now + seconds * 1000);
  };
  const state = () => ({
    uuid: "c1",
    cmdline: "x",
    cwd: null,
    env: null,
    pty: false,
    duration_ms: 1,
    exitcode: exited ? 0 : null,
    capped: !exited && written - released >= ceiling,
  });
  const logs = () => {
    const held = Buffer.from(letters(released, Math.min(written, released + page)));
    const full = { text: held.toString("base64"), available: written, first: released };
    const empty = { text: "", available: 0, first: 0 };
    const [out, err] = stream === "stdout" ? [full, empty] : [empty, full];
    return {
      stdout: out.text,
      stderr: err.text,
      stdout_available: out.available,
      stderr_available: err.available,
      stdout_first: out.first,
      stderr_first: err.first,
    };
  };

  const fake = mock((url, init) => {
    if (!url.includes("/plugins/")) return undefined;
    if (gone && url.includes("/commands/c1")) return error(404, "No such command");
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (url.endsWith("/commands") && init.method === "POST") {
      hold(body.req_timeout_s ?? 0);
      const answer = logs();
      gone = exited && body.forget === true && released + page >= written;
      return json({ ...state(), logs: answer });
    }
    if (url.endsWith("/wait_timeout")) {
      hold(body.timeout_s);
      return exited ? json(null) : error(408, "Timed out");
    }
    if (url.endsWith("/logs/release")) {
      if (!exited) released = Math.max(released, Math.min(written, body[stream] ?? 0));
      return json(null);
    }
    if (url.endsWith(`/logs/raw/${stream}`)) {
      const from = Number(/bytes=(\d+)-/.exec(new Headers(init.headers).get("range") ?? "")?.[1]);
      if (from < released || from >= written) return error(416, "Range not satisfiable");
      const to = exited ? written : Math.min(written, from + page);
      return new Response(letters(from, to), { status: 206 });
    }
    if (url.endsWith("/logs")) return json(logs());
    if (url.endsWith("/commands/c1") && init.method === "DELETE") {
      gone = true;
      return json(null);
    }
    if (url.endsWith("/commands/c1")) return json(state());
    return undefined;
  });
  return { ...fake, gone: () => gone };
}

test("1. the caller's own sandbox plugin entry is kept, not duplicated", async () => {
  const { calls, fetchImpl } = mock();
  const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: fetchImpl });
  await ukc.metro("fra").sandboxes.create({
    image: "img",
    plugins: [{ name: "sandbox", image: "mine:1", config: { a: 1 } }],
  });
  expect(calls[0]?.body.plugins).toEqual([{ name: "sandbox", image: "mine:1", config: { a: 1 } }]);

  // A different name still gets the sandbox plugin added alongside.
  calls.length = 0;
  await ukc
    .metro("fra")
    .sandboxes.create({ image: "img", plugins: [{ name: "other", image: "o:1" }] });
  // The constant, not a copy of its value: the assertion is that the entry is
  // added, not what the default image happens to say.
  expect(calls[0]?.body.plugins).toEqual([
    { name: "sandbox", image: DEFAULT_PLUGIN_IMAGE },
    { name: "other", image: "o:1" },
  ]);

  // `rom` is the former name of `pluginImage`, and the platform now wants
  // `image` on the wire, so the deprecated name still reaches it as `image`.
  calls.length = 0;
  await ukc.metro("fra").sandboxes.create({ image: "img", rom: "old:1" });
  expect(calls[0]?.body.plugins).toEqual([{ name: "sandbox", image: "old:1" }]);

  // Both names for the plugin image is a contradiction, and so is the
  // shorthand next to an entry of the same name.
  for (const spec of [
    { image: "img", pluginImage: "a:1", rom: "b:1" },
    { image: "img", pluginImage: "a:1", plugins: [{ name: "sandbox", image: "b:1" }] },
  ]) {
    await expect(ukc.metro("fra").sandboxes.create(spec)).rejects.toMatchObject({
      kind: "config",
    });
  }

  // A conflict names the spelling the caller used, not its replacement, for
  // both a same-name entry and a snapshot source.
  for (const spec of [
    { image: "img", rom: "a:1", plugins: [{ name: "sandbox", image: "b:1" }] },
    { template: { uuid: "t1" }, rom: "a:1" },
  ]) {
    await expect(ukc.metro("fra").sandboxes.create(spec)).rejects.toThrow(/`rom`/);
  }

  // A snapshot source already carries the sandbox plugin, so naming it again
  // is refused before the platform answers EINVAL; another plugin still passes.
  for (const spec of [
    { template: { uuid: "t1" }, pluginImage: "a:1" },
    { template: { uuid: "t1" }, plugins: [{ name: "sandbox", image: "b:1" }] },
  ]) {
    await expect(ukc.metro("fra").sandboxes.create(spec)).rejects.toMatchObject({
      kind: "config",
    });
  }
  calls.length = 0;
  await ukc
    .metro("fra")
    .sandboxes.create({ template: { uuid: "t1" }, plugins: [{ name: "other", image: "o:1" }] });
  expect(calls[0]?.body.plugins).toEqual([{ name: "other", image: "o:1" }]);
  calls.length = 0;
  const custom = await ukc
    .metro("fra")
    .sandboxes.create({ template: { uuid: "t1" }, pluginName: "custom" });
  expect(custom.pluginName).toBe("custom");
  expect(calls[0]?.body).not.toHaveProperty("plugins");
});

test("2. `metros` picks the metro instead of being ignored", async () => {
  const { calls, fetchImpl } = mock();
  const sb = await Sandbox.create(
    { image: "img" },
    { token: "t", metros: "dal", fetch: fetchImpl },
  );
  expect(sb.metro).toBe("dal");
  expect(calls[0]?.url).toBe("https://api.dal.unikraft.cloud/v1/instances");

  // A scope spanning several metros cannot mean one create.
  await expect(
    Sandbox.create({ image: "img" }, { token: "t", metros: ["dal", "fra"], fetch: fetchImpl }),
  ).rejects.toThrow(/single metro/);
});

test("3. options that need a client we already have are refused", async () => {
  const { fetchImpl } = mock();
  const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: fetchImpl });
  // The option types exclude these keys, so a TypeScript caller never gets
  // here; the cast stands in for the JavaScript caller who does.
  const sneak = (opts: unknown) => opts as never;
  await expect(
    ukc.metro("fra").sandboxes.create({ image: "img" }, sneak({ token: "other" })),
  ).rejects.toMatchObject({ kind: "config" });
  await expect(
    ukc.metro("fra").sandboxes.get({ uuid: "u1" }, sneak({ token: "other" })),
  ).rejects.toThrow(/would be ignored/);
  // The same token on `Sandbox.create`, which builds the client, is accepted.
  await expect(
    Sandbox.create({ image: "img" }, { token: "t", metro: "fra", fetch: fetchImpl }),
  ).resolves.toBeDefined();

  // Borrowing a client is a door that takes `client`, so the options that
  // would have built one are refused there too, rather than silently dropped.
  await expect(Sandbox.create({ image: "img" }, { client: ukc, token: "other" })).rejects.toThrow(
    /would be ignored/,
  );
  await expect(
    Sandbox.connect({ uuid: "u1", metro: "fra" }, { client: ukc, userAgent: "ua/1" }),
  ).rejects.toMatchObject({ kind: "config" });
  // The metro is not one of them: it says where the sandbox goes, and the
  // borrowed client still serves it.
  await expect(
    Sandbox.create({ image: "img" }, { client: ukc, metros: "dal" }),
  ).resolves.toMatchObject({ metro: "dal" });
});

test("3b. a metro or a client on the instance door is refused, not ignored", async () => {
  const { calls, fetchImpl } = mock();
  const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: fetchImpl });
  const sneak = (opts: unknown) => opts as never;

  // `ukc.metro("fra").sandboxes` is already one metro, so a second one here can
  // only contradict it.
  await expect(
    ukc.metro("fra").sandboxes.create({ image: "img" }, sneak({ metros: "dal" })),
  ).rejects.toThrow(/pick the metro one step earlier/);
  await expect(
    ukc.metro("fra").sandboxes.create({ image: "img" }, sneak({ metro: "dal" })),
  ).rejects.toMatchObject({ kind: "config" });
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

  // A URL-shaped `metro` is a `baseUrl`, since `Metro` accepts one, so it is
  // refused as a client option rather than by the shape of the string.
  await expect(
    ukc
      .metro("fra")
      .sandboxes.create({ image: "img" }, sneak({ metro: "https://api.staging.example.com" })),
  ).rejects.toThrow(/would be ignored/);

  // A borrowed client on a door that already has one is the same contradiction.
  await expect(
    ukc.metro("fra").sandboxes.get({ uuid: "u1" }, sneak({ client: ukc })),
  ).rejects.toThrow(/that client's own `sandboxes`/);
});

test("3c. the static doors still spend and then drop the client options", async () => {
  const { calls, fetchImpl } = mock();
  // Every client-only key at once, through the door that accepts them all.
  const opts = { token: "t", metros: "dal", fetch: fetchImpl, userAgent: "ua/1" } as const;
  const sb = await Sandbox.create({ image: "img" }, opts);
  expect(sb.metro).toBe("dal");
  expect(calls[0]?.url).toBe("https://api.dal.unikraft.cloud/v1/instances");
  expect(calls[0]?.headers["User-Agent"]).toBe("ua/1");
  // The caller's object is untouched, so it can be reused.
  expect(opts.token).toBe("t");

  // And `connect` reaches the same metro without re-reading the options.
  const sb2 = await Sandbox.connect({ uuid: "u1", metro: "dal" }, { token: "t", fetch: fetchImpl });
  expect(sb2.metro).toBe("dal");
});

test("4. a missing token rejects the promise instead of throwing synchronously", async () => {
  vi.stubEnv("UKC_TOKEN", "");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  // A synchronous throw would fail this test on the call itself, before the
  // `expect` runs, which is exactly the regression this guards against.
  const pending = Sandbox.connect({ uuid: "u1", metro: "fra" });
  await expect(pending).rejects.toMatchObject({ kind: "config" });
});

test("9. the create fields the spec excludes are refused, not forwarded", async () => {
  const { calls, fetchImpl } = mock();
  const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: fetchImpl });
  // The spec type excludes these keys, so a TypeScript caller never gets here;
  // the cast stands in for the JavaScript caller who does.
  const sneak = (spec: unknown) => spec as never;

  await expect(
    ukc.metro("fra").sandboxes.create(sneak({ image: "img", replicas: 2 })),
  ).rejects.toMatchObject({ kind: "config" });
  for (const field of [{ autostart: false }, { timeout_s: 5 }, { wait_timeout_ms: 5000 }]) {
    await expect(
      ukc.metro("fra").sandboxes.create(sneak({ image: "img", ...field })),
    ).rejects.toThrow(/bootTimeoutSeconds/);
  }
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
});

test("11. the readiness deadline aborts the probe in flight", async () => {
  const probeSignals: Array<AbortSignal | undefined> = [];
  const { fetchImpl } = mock();
  // The plugin endpoint never answers, so only the waiter's signal can stop
  // the request underneath.
  const hanging = vi.fn(async (input: unknown, init: { signal?: AbortSignal } = {}) => {
    if (String(input).includes("/plugins/")) {
      probeSignals.push(init.signal);
      return new Promise<Response>(() => {});
    }
    return fetchImpl(input, init);
  });
  const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: hanging as never });
  const err = await ukc
    .metro("fra")
    .sandboxes.create({ image: "img" }, { ready: { timeoutMs: 20, initialDelayMs: 1 } })
    .catch((e) => e as UnikraftCloudError);
  expect(err).toBeInstanceOf(UnikraftCloudError);
  expect((err as UnikraftCloudError).kind).toBe("timeout");
  expect(probeSignals[0]?.aborted).toBe(true);
});

test("5a. a pinned staging cluster serves the plugin endpoint", async () => {
  const { calls, fetchImpl } = mock();
  const ukc = new UnikraftCloud({
    token: "t",
    metro: "https://api.ukp-staging.example.com",
    fetch: fetchImpl,
  });
  await ukc.metro("fra").sandboxes.create({ image: "img" });
  expect(calls.every((c) => new URL(c.url).origin === "https://api.ukp-staging.example.com")).toBe(
    true,
  );
  expect(calls.every((c) => c.url.startsWith("https://api.ukp-staging.example.com"))).toBe(true);

  // Same through the `Sandbox.create` door, and via `baseUrl`.
  const sb2 = await Sandbox.create(
    { image: "img" },
    { token: "t", baseUrl: "https://api.ukp-staging.example.com", fetch: fetchImpl },
  );
  expect(sb2.baseUrl).toBe("https://api.ukp-staging.example.com/v1/instances/u1/plugins/sandbox");

  // A per-call `baseUrl` redirects the read, and the sandbox it yields must
  // address its plugin on that host too. The pinned endpoint would otherwise
  // win and every later call would leave the cluster the list came from.
  const listed: Sandbox[] = [];
  for await (const sb of ukc
    .metro("fra")
    .sandboxes.list({ baseUrl: "https://api.other-staging.example.com/v1" })) {
    listed.push(sb);
  }
  expect(listed[0]?.baseUrl).toBe(
    "https://api.other-staging.example.com/v1/instances/u1/plugins/sandbox",
  );
});

test("5b. a discovered metro's own endpoint is used, not one built from the code", async () => {
  const { calls, fetchImpl } = mock();
  const ukc = new UnikraftCloud({ token: "t", fetch: fetchImpl });
  const sb = await Sandbox.connect({ uuid: "u1" }, { client: ukc });
  expect(sb.metro).toBe("fra");
  expect(sb.baseUrl).toBe("https://api.fra-2.internal.example/v1/instances/u1/plugins/sandbox");

  // The instance underneath is addressed through the same discovered endpoint,
  // not through one rebuilt from the metro code.
  calls.length = 0;
  await sb.delete();
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(new URL(call.url).origin).toBe("https://api.fra-2.internal.example");
  }

  // And so is the metro door, which is the other way to the same sandboxes.
  // Creating on one host and probing on another would be silent until the
  // plugin 404s for the whole readiness wait.
  calls.length = 0;
  const made = await ukc.metro("fra").sandboxes.create({ image: "img" });
  expect(made.baseUrl).toBe("https://api.fra-2.internal.example/v1/instances/u1/plugins/sandbox");
  for (const call of calls) {
    expect(new URL(call.url).origin).toBe("https://api.fra-2.internal.example");
  }
  // Including the raw surface that door exposes, which a caller reaches past
  // the porcelain with.
  expect(ukc.metro("fra").endpoint.baseUrl).toBe("https://api.fra-2.internal.example");
});

// The time a request asks the plugin to hold it for, as the plugin reads it.
const held = (body: any): number | undefined => body?.req_timeout_s ?? body?.timeout_s;

test.each([
  {
    what: "exits in the first slice",
    exitsAfterS: 1,
    opts: {},
    requests: [["POST", MAX_WAIT_SLICE_S]],
    exitcode: 0,
  },
  {
    what: "times out in the first slice",
    exitsAfterS: 600,
    opts: { timeoutSeconds: 5 },
    requests: [["POST", 5]],
    exitcode: null,
  },
  {
    what: "times out past one slice",
    exitsAfterS: 600,
    opts: { timeoutSeconds: 120 },
    requests: [["POST", 55], ["POST", 55], ["POST", 10], ["GET"], ["GET"]],
    exitcode: null,
  },
  {
    what: "runs past one slice with no timeout",
    exitsAfterS: 600,
    opts: {},
    requests: [
      ["POST", 55],
      ...Array.from({ length: 10 }, () => ["POST", 55]),
      ["GET"],
      ["GET"],
      ["DELETE"],
    ],
    exitcode: 0,
  },
  {
    what: "gets no time at all",
    exitsAfterS: 600,
    opts: { timeoutSeconds: 0 },
    requests: [["POST"], ["POST", 0], ["GET"], ["GET"]],
    exitcode: null,
  },
])(
  "6. `exec` holds the plugin for at most one slice per request: a command that $what",
  async ({ exitsAfterS, opts, requests, exitcode }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { calls, fetchImpl } = fakePlugin({ exitsAfterS });
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: fetchImpl });
    const sb = await ukc.metro("fra").sandboxes.create({ image: "img" });
    calls.length = 0;

    const res = await sb.exec("x", opts);

    expect(res).toMatchObject({ uuid: "c1", stdout: "out", stderr: "", exitcode });
    expect(
      calls.map((c) => [c.method, ...(held(c.body) === undefined ? [] : [held(c.body)])]),
    ).toEqual(requests);
    // Every start closes stdin, the plain one too. `forget` rides on every
    // start that holds the request, and only there, because the plugin answers
    // 400 to it on a plain start. It does nothing on a timeout, so the record
    // of a timed-out command survives, as `requests` shows: no `DELETE` follows
    // an `exitcode: null`.
    const start = calls[0]?.body;
    expect(start?.stdin_eof).toBe(true);
    expect(start?.forget).toBe(held(start) === undefined ? undefined : true);
  },
);

test.each([
  { plugin: "1.3.0", fake: () => fakePlugin({ exitsAfterS: 100 }) },
  { plugin: "1.4.0", fake: () => releasingPlugin({ bytes: 100, bytesPerS: 1 }) },
])("6b. `keep` leaves the record and all its output on plugin $plugin", async ({ fake }) => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const { calls, fetchImpl } = fake();
  const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: fetchImpl });
  const sb = await ukc.metro("fra").sandboxes.create({ image: "img" });
  calls.length = 0;

  await sb.exec("x", { keep: true });

  expect(calls[0]?.body).not.toHaveProperty("forget");
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  expect(calls.some((c) => c.url.endsWith("/logs/release"))).toBe(false);
});

test("6c. a plugin that ignores `req_timeout_s` gets the multi-request path", async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const { calls, fetchImpl } = fakePlugin({ exitsAfterS: 1, rom: "ignores" });
  const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: fetchImpl });
  const sb = await ukc.metro("fra").sandboxes.create({ image: "img" });

  calls.length = 0;
  expect(await sb.exec("x")).toMatchObject({ stdout: "out", exitcode: 0 });
  // The answer names the command but carries no output, so `exec` continues
  // from the command it did start.
  expect(calls.map((c) => c.method)).toEqual(["POST", "POST", "GET", "GET", "DELETE"]);
  expect(calls[0]?.body.req_timeout_s).toBe(MAX_WAIT_SLICE_S);
});

test.each([
  {
    what: "fills its share of memory many times over",
    plugin: { bytes: 1024 * 1024, bytesPerS: 64 * 1024, ceiling: 64 * 1024 },
  },
  {
    what: "fills its share of memory many times over on stderr",
    plugin: {
      bytes: 1024 * 1024,
      bytesPerS: 64 * 1024,
      ceiling: 64 * 1024,
      stream: "stderr" as const,
    },
  },
  {
    what: "writes more than one page to a volume before the start answers",
    plugin: { bytes: 256 * 1024, bytesPerS: 64 * 1024, page: 64 * 1024 },
  },
  {
    what: "writes more than one page to a volume and runs past one slice",
    plugin: { bytes: 1024 * 1024, bytesPerS: 16 * 1024, page: 64 * 1024 },
  },
])("6d. `exec` returns all the output of a command that $what", async ({ plugin }) => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const { calls, fetchImpl, gone } = releasingPlugin(plugin);
  const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: fetchImpl });
  const sb = await ukc.metro("fra").sandboxes.create({ image: "img" });
  calls.length = 0;

  // Without a release the command never exits. The timeout makes such a
  // regression fail on the assertions below, and not hang the suite.
  const res = await sb.exec("x", { timeoutSeconds: 600 });

  const stream = plugin.stream ?? "stdout";
  expect(res.exitcode).toBe(0);
  expect(res[stream]).toHaveLength(plugin.bytes);
  expect(res[stream]).toBe(new TextDecoder().decode(letters(0, plugin.bytes)));
  // The plugin ignores `forget` on an answer that leaves output out, so a
  // record that `exec` does not delete stays in the sandbox.
  expect(gone()).toBe(true);
  for (const call of calls) expect(held(call.body) ?? 0).toBeLessThanOrEqual(MAX_WAIT_SLICE_S);
});

// The 1.4.0 models type both fields as present, so only a runtime test sees
// that an older plugin leaves them out.
test("15. `logs` on a plugin before 1.4.0 says that its output starts at byte 0", async () => {
  const { fetchImpl } = mock((url) =>
    url.endsWith("/commands/c1/logs")
      ? json({ stdout: "b3V0", stderr: "", stdout_available: 3, stderr_available: 0 })
      : undefined,
  );
  const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: fetchImpl });
  const sb = await ukc.metro("fra").sandboxes.create({ image: "img" });

  const logs = await sb.command("c1").logs();

  expect([logs.stdout_first, logs.stderr_first]).toEqual([0, 0]);
});

test.each([
  {
    what: "a command at its output limit",
    previous: 55,
    capped: true,
    bytes: READ_EVERY_BYTES,
    s: 55,
    wait: 0,
  },
  {
    what: "a command at the limit of the whole sandbox",
    previous: 4,
    capped: true,
    bytes: 0,
    s: 4,
    wait: 8,
  },
  {
    what: "a quiet command after a read at once",
    previous: 0,
    capped: false,
    bytes: 0,
    s: 0,
    wait: 1,
  },
  { what: "a quiet command", previous: 32, capped: false, bytes: 0, s: 32, wait: MAX_WAIT_SLICE_S },
  {
    what: "a command that writes fast",
    previous: 55,
    capped: false,
    bytes: 2 * READ_EVERY_BYTES,
    s: 10,
    wait: 5,
  },
])(
  "16. `exec` waits $wait s before the next read of $what",
  ({ previous, capped, bytes, s, wait }) => {
    expect(nextWait(previous, capped, bytes, s)).toBe(wait);
  },
);

test("7. headers reach the create call", async () => {
  const { calls, fetchImpl } = mock();
  const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: fetchImpl });
  await ukc.metro("fra").sandboxes.create({ image: "img" }, { headers: { "X-Trace": "abc" } });
  expect(calls[0]?.headers["X-Trace"]).toBe("abc");
  expect(calls[1]?.headers["X-Trace"]).toBe("abc");
});

test("8. a sandbox takes the defaults the spec leaves out", async () => {
  const { calls, fetchImpl } = mock();
  const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: fetchImpl });
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  await ukc.metro("fra").sandboxes.create();
  expect(calls[0]?.body.memory_mb).toBe(2048);
  expect(calls[0]?.body.image).toBe(DEFAULT_IMAGE);

  calls.length = 0;
  await ukc.metro("fra").sandboxes.create({ image: "img", memory_mb: 512 });
  expect(calls[0]?.body.memory_mb).toBe(512);
  expect(calls[0]?.body.image).toBe("img");

  // The environment sits between the two: it beats the built-in default, and
  // the spec beats it.
  calls.length = 0;
  vi.stubEnv("UKC_SANDBOX_IMAGE", "from-env");
  await ukc.metro("fra").sandboxes.create();
  expect(calls[0]?.body.image).toBe("from-env");

  calls.length = 0;
  await ukc.metro("fra").sandboxes.create({ image: "img" });
  expect(calls[0]?.body.image).toBe("img");

  calls.length = 0;
  vi.stubEnv("UKC_SANDBOX_IMAGE", "");
  await ukc.metro("fra").sandboxes.create({ image: "" });
  expect(calls[0]?.body.image).toBe(DEFAULT_IMAGE);

  // `template`, `branch_from` and `checkpoint` create from a snapshot that
  // carries the image, the memory and the plugins, and the platform answers
  // 400 to `memory_mb` and EINVAL to a repeated plugin, so none of the three
  // defaults rides along. The autokill default does: a snapshot accepts it.
  vi.stubEnv("UKC_SANDBOX_IMAGE", "from-env");
  for (const source of [
    { template: { uuid: "t1" } },
    { branch_from: { name: "other" } },
    { checkpoint: { name: "cp1" } },
  ]) {
    calls.length = 0;
    await ukc.metro("fra").sandboxes.create(source);
    expect(calls[0]?.body).toMatchObject({
      ...source,
      autostart: true,
      autokill: { time_ms: DEFAULT_AUTOKILL_MS },
    });
    expect(calls[0]?.body).not.toHaveProperty("image");
    expect(calls[0]?.body).not.toHaveProperty("memory_mb");
    expect(calls[0]?.body).not.toHaveProperty("plugins");
  }

  // `ready: false` returns as soon as the instance exists, so the boot wait
  // defaults to zero there. An explicit wait still wins.
  calls.length = 0;
  await ukc.metro("fra").sandboxes.create({ image: "img" });
  expect(calls[0]?.body.timeout_s).toBe(DEFAULT_BOOT_TIMEOUT_S);
  calls.length = 0;
  await ukc.metro("fra").sandboxes.create({ image: "img" }, { ready: false });
  expect(calls[0]?.body.timeout_s).toBe(0);
  calls.length = 0;
  await ukc
    .metro("fra")
    .sandboxes.create({ image: "img" }, { ready: false, bootTimeoutSeconds: 10 });
  expect(calls[0]?.body.timeout_s).toBe(10);
});

test.each([
  { what: "a zero limit", opts: { limit: 0 } },
  { what: "a fractional limit", opts: { limit: 2.5 } },
  { what: "a NaN offset", opts: { offset: Number.NaN } },
  { what: "an infinite offset", opts: { offset: Number.NEGATIVE_INFINITY } },
])("12. $what is refused before it reaches the wire", async ({ opts }) => {
  const { calls, fetchImpl } = mock();
  const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: fetchImpl });
  const sb = await ukc.metro("fra").sandboxes.create({ image: "img" });
  calls.length = 0;
  await expect(sb.command("c1").logsRaw("stdout", opts)).rejects.toMatchObject({
    kind: "config",
  });
  expect(calls).toHaveLength(0);
});

test("10. a readiness timeout carries no status", async () => {
  const { calls, fetchImpl } = mock((url) =>
    url.includes("/plugins/")
      ? new Response("{}", { status: 404, headers: { "content-type": "application/json" } })
      : undefined,
  );
  const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: fetchImpl });
  const wait = { ready: { timeoutMs: 30, initialDelayMs: 1 } };
  const err = await ukc
    .metro("fra")
    .sandboxes.create({ image: "img" }, wait)
    .catch((e) => e as UnikraftCloudError);
  expect(err).toBeInstanceOf(UnikraftCloudError);
  expect((err as UnikraftCloudError).kind).toBe("timeout");
  expect((err as UnikraftCloudError).status).toBeUndefined();
  expect((err as UnikraftCloudError).message).toMatch(/the instance is running/);

  // `create` made the machine, so it deletes it on the way out and says so.
  expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  expect((err as UnikraftCloudError).message).toMatch(/The sandbox was deleted/);

  // `get` did not make the machine, so a failed probe leaves it alone.
  calls.length = 0;
  const err2 = await ukc
    .metro("fra")
    .sandboxes.get({ uuid: "u1" }, wait)
    .catch((e) => e as UnikraftCloudError);
  expect((err2 as UnikraftCloudError).kind).toBe("timeout");
  expect((err2 as UnikraftCloudError).message).not.toMatch(/deleted/);
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
});

test("10b. an instance that never ran is diagnosed as a pull, not a crash", async () => {
  // A stopped instance, carrying whichever witnesses of having run a case needs.
  const stoppedAfter = (ran: Record<string, unknown>) =>
    mock((url) =>
      url.includes("/plugins/")
        ? new Response("{}", { status: 404, headers: { "content-type": "application/json" } })
        : json({
            instances: [
              {
                uuid: "u1",
                state: "stopped",
                image: "my-org/base:latest",
                plugins: [{ name: "sandbox", image: "plugins/sandbox:typo" }],
                ...ran,
              },
            ],
          }),
    );
  const wait = { ready: { timeoutMs: 30, initialDelayMs: 1 } };

  // Never started: no counter, no timestamp, and a `stop_reason` with neither
  // the App nor the Kernel bit. This is what a failed image pull looks like.
  const { fetchImpl } = stoppedAfter({ stop_reason: 0b00100 });
  const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: fetchImpl });
  const err = await ukc
    .metro("fra")
    .sandboxes.create({ image: "my-org/base:latest" }, wait)
    .catch((e) => e as UnikraftCloudError);
  const message = (err as UnikraftCloudError).message;
  expect(message).toMatch(/never started/);
  // Both names the platform had to fetch, so a typo is visible in the message.
  expect(message).toContain("`my-org/base:latest`");
  expect(message).toContain("`plugins/sandbox:typo`");
  expect(message).not.toMatch(/console log/);

  // Ran and then exited: the console log is the right place to look.
  for (const ran of [
    { start_count: 1 },
    { started_at: "2026-01-01T00:00:00Z" },
    { stop_reason: 0b00011 },
  ]) {
    const crashed = stoppedAfter({ ...ran, exit_code: 1 });
    const err2 = await new UnikraftCloud({ token: "t", metro: "fra", fetch: crashed.fetchImpl })
      .metro("fra")
      .sandboxes.create({ image: "my-org/base:latest" }, wait)
      .catch((e) => e as UnikraftCloudError);
    expect((err2 as UnikraftCloudError).message).toMatch(/console log/);
    expect((err2 as UnikraftCloudError).message).toMatch(/exited with code 1/);
  }
});

test("10c. a plugin error is the SDK's own UnikraftCloudError", async () => {
  const { fetchImpl } = mock((url, init) =>
    url.includes("/plugins/") && init.method === "POST"
      ? new Response(JSON.stringify({ status: "error", message: "boom", op_time_us: 1 }), {
          status: 500,
          headers: { "content-type": "application/json" },
        })
      : undefined,
  );
  const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: fetchImpl });
  const sb = await ukc.metro("fra").sandboxes.create({ image: "img" }, { ready: false });
  const failure = sb.exec("true");
  await expect(failure).rejects.toBeInstanceOf(UnikraftCloudError);
  await expect(failure).rejects.toMatchObject({ kind: "http", status: 500 });
});

test("13. disposing a sandbox that is already gone is not an error", async () => {
  // The platform reports a missing instance as HTTP 200 carrying an error
  // envelope, and the entry's code 8 is what the SDK reads as a 404.
  const { fetchImpl } = mock((url, init) =>
    init.method === "DELETE" && !url.includes("/plugins/")
      ? new Response(
          JSON.stringify({
            status: "error",
            message: "Failed to perform all operations",
            data: { instances: [{ uuid: "u1", status: "error", error: 8 }] },
            op_time_us: 1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      : undefined,
  );
  const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: fetchImpl });
  const sb = await ukc.metro("fra").sandboxes.create({ image: "img" });

  // Deleting it yourself still reports the outcome.
  await expect(sb.delete()).rejects.toMatchObject({ status: 404 });
  // Leaving the scope afterwards must not fail a block that succeeded.
  await expect(sb[Symbol.asyncDispose]()).resolves.toBeUndefined();
});

test("14. a signal on the call ends the readiness wait, not only one on the policy", async () => {
  const controller = new AbortController();
  // The plugin never answers, so only a signal can end this wait. Aborting on
  // the first probe leaves no question about which one ended it.
  const { fetchImpl } = mock((url) => {
    if (!url.includes("/plugins/")) return undefined;
    controller.abort();
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  });
  const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: fetchImpl });

  // A deadline far enough out that reaching it is the regression, not the pass.
  const pending = ukc
    .metro("fra")
    .sandboxes.get(
      { uuid: "u1" },
      { ready: { initialDelayMs: 1, timeoutMs: 500 }, signal: controller.signal },
    );

  await expect(pending).rejects.toThrow(/abort/i);
});

test("ApiClient satisfies the plugin package's Transport", () => {
  // Checked by `tsc`; the generated plugin classes accept nothing else.
  expectTypeOf<ApiClient>().toExtend<Transport>();
});
