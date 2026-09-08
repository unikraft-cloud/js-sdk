// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// Tests for the Sandbox client, in the `fetch`-mocking style of
// `client.test.ts`. They live here rather than there because that file is
// already long; extend this one rather than starting a third.

import { expect, onTestFinished, test, vi } from "vitest";
import { Sandbox, UnikraftCloud, UnikraftCloudError } from "../src/index.js";
import { DEFAULT_IMAGE, DEFAULT_PLUGIN_ROM } from "../src/resources/sandboxes/options.js";

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
      if (url.endsWith("/wait") || url.endsWith("/wait_timeout")) return json(null);
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
      instances: [{ uuid: "u1", state: "running", plugins: [{ name: "sandbox", rom: "r" }] }],
    });
  }) as any;
  return { calls, fetchImpl };
}

test("1. the caller's own sandbox plugin entry is kept, not duplicated", async () => {
  const { calls, fetchImpl } = mock();
  const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: fetchImpl });
  await ukc.metro("fra").sandboxes.create({
    image: "img",
    plugins: [{ name: "sandbox", rom: "mine:1", config: { a: 1 } }],
  });
  expect(calls[0]?.body.plugins).toEqual([{ name: "sandbox", rom: "mine:1", config: { a: 1 } }]);

  // A different name still gets the sandbox plugin added alongside.
  calls.length = 0;
  await ukc
    .metro("fra")
    .sandboxes.create({ image: "img", plugins: [{ name: "other", rom: "o:1" }] });
  // The constant, not a copy of its value: the assertion is that the entry is
  // added, not what the default ROM happens to say.
  expect(calls[0]?.body.plugins).toEqual([
    { name: "sandbox", rom: DEFAULT_PLUGIN_ROM },
    { name: "other", rom: "o:1" },
  ]);

  // Both `rom` and an entry of the same name is a contradiction.
  await expect(
    ukc
      .metro("fra")
      .sandboxes.create({ image: "img", rom: "a:1", plugins: [{ name: "sandbox", rom: "b:1" }] }),
  ).rejects.toMatchObject({ kind: "config" });
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

test("5a. a pinned staging cluster serves the plugin endpoint", async () => {
  const { calls, fetchImpl } = mock();
  const ukc = new UnikraftCloud({
    token: "t",
    metro: "https://api.ukp-staging.example.com",
    fetch: fetchImpl,
  });
  const sb = await ukc.metro("fra").sandboxes.create({ image: "img" });
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
});

test("5b. a discovered metro's own endpoint is used, not one built from the code", async () => {
  const { fetchImpl } = mock();
  const ukc = new UnikraftCloud({ token: "t", fetch: fetchImpl });
  const sb = await Sandbox.connect({ uuid: "u1" }, { client: ukc });
  expect(sb.metro).toBe("fra");
  expect(sb.baseUrl).toBe("https://api.fra-2.internal.example/v1/instances/u1/plugins/sandbox");
});

test("6. a timed-out command is not deleted", async () => {
  const { calls, fetchImpl } = mock();
  const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: fetchImpl });
  const sb = await ukc.metro("fra").sandboxes.create({ image: "img" });
  calls.length = 0;
  const res = await sb.exec("sleep 100", { timeoutSeconds: 1 });
  expect(res.exitcode).toBeNull();
  expect(calls.map((c) => c.method)).toEqual(["POST", "POST", "GET", "GET"]);
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
});

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
});

test("12. a zero limit is refused", async () => {
  const { fetchImpl } = mock();
  const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: fetchImpl });
  const sb = await ukc.metro("fra").sandboxes.create({ image: "img" });
  await expect(sb.command("c1").logsRaw("stdout", { limit: 0 })).rejects.toMatchObject({
    kind: "config",
  });
});

test("10. a readiness timeout carries no status", async () => {
  const { fetchImpl } = mock((url) =>
    url.includes("/plugins/")
      ? new Response("{}", { status: 404, headers: { "content-type": "application/json" } })
      : undefined,
  );
  const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch: fetchImpl });
  const err = await ukc
    .metro("fra")
    .sandboxes.create({ image: "img" }, { ready: { timeoutMs: 30, initialDelayMs: 1 } })
    .catch((e) => e as UnikraftCloudError);
  expect(err).toBeInstanceOf(UnikraftCloudError);
  expect((err as UnikraftCloudError).kind).toBe("timeout");
  expect((err as UnikraftCloudError).status).toBeUndefined();
  expect((err as UnikraftCloudError).message).toMatch(/the instance is running/);
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
                plugins: [{ name: "sandbox", rom: "plugins/sandbox:typo" }],
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
