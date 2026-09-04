// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AmbiguousRefError,
  type FetchLike,
  MetroFanoutError,
  UnikraftCloud,
  UnikraftCloudError,
  collect,
  metroBaseUrl,
  toQuery,
} from "../src/index.js";

interface Call {
  url: string;
  init?: RequestInit;
}

// The client falls back to UKC_METRO and UKC_TOKEN; a developer's real values
// would otherwise pin the scope and change what these tests exercise.
beforeEach(() => {
  vi.stubEnv("UKC_METRO", undefined);
  vi.stubEnv("UKC_TOKEN", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Build a fake fetch that returns queued JSON responses and records calls. */
function fakeFetch(pages: Array<{ status?: number; body: unknown }>): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const page = pages[Math.min(i, pages.length - 1)];
    i += 1;
    if (!page) throw new Error("no queued response");
    return new Response(JSON.stringify(page.body), {
      status: page.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

/**
 * Build a fake fetch that answers per URL. Metro fan-out runs concurrently, so
 * responses cannot be queued in a fixed order — they are routed instead.
 */
function routedFetch(route: (url: URL, init?: RequestInit) => { status?: number; body: unknown }): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const { status, body } = route(new URL(url), init);
    return new Response(JSON.stringify(body), {
      status: status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

const ok = (data: unknown) => ({ body: { status: "success", op_time_us: 1, data } });
const okBody = (data: unknown) => ({ status: "success", op_time_us: 1, data });

/** The metro an URL targets, e.g. `https://api.fra.unikraft.cloud` -> `fra`. */
const metroOf = (url: URL) => url.hostname.split(".")[1] as string;

/** The control plane's answer for a set of metros. */
const metrosBody = (codes: string[]) =>
  okBody({
    metros: codes.map((code) => ({
      uuid: `uuid-${code}`,
      name: code,
      iata_code: code,
      country: "xx",
      endpoint: `https://api.${code}.unikraft.cloud`,
    })),
  });

describe("metroBaseUrl", () => {
  it("builds a regional URL", () => {
    expect(metroBaseUrl("fra")).toBe("https://api.fra.unikraft.cloud");
  });

  it("uses a full URL verbatim", () => {
    expect(metroBaseUrl("https://api.staging.internal")).toBe("https://api.staging.internal");
    expect(metroBaseUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
    expect(metroBaseUrl("http://127.0.0.1:8080///")).toBe("http://127.0.0.1:8080");
  });

  it("drops a trailing /v1 the operation paths already carry", () => {
    expect(metroBaseUrl("https://api.staging.internal/v1")).toBe("https://api.staging.internal");
  });
});

describe("a client pinned to one metro", () => {
  it("targets the configured metro and sends a bearer token", async () => {
    const { fetch, calls } = fakeFetch([ok({ instances: [{ uuid: "u1", name: "web" }] })]);
    const ukc = new UnikraftCloud({ token: "secret", metro: "dal", fetch });

    const inst = await ukc.instances.get({ name: "web" });

    expect(inst.name).toBe("web");
    // Every result says which metro it came from.
    expect(inst.metro).toBe("dal");
    const url = new URL(calls[0]?.url ?? "");
    expect(url.origin).toBe("https://api.dal.unikraft.cloud");
    expect(url.pathname).toBe("/v1/instances");
    // Only the field the caller supplied is sent: the API rejects a name in
    // the `uuid` filter with `Invalid uuid '<name>'`.
    expect(Object.fromEntries(url.searchParams)).toEqual({ name: "web", details: "true" });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret");
  });

  it("targets a full URL passed as the metro", async () => {
    const { fetch, calls } = fakeFetch([ok({ instances: [{ uuid: "u1" }] })]);
    const ukc = new UnikraftCloud({
      token: "t",
      metro: "https://api.staging.internal/v1",
      fetch,
    });

    await ukc.instances.get({ name: "web" });

    expect(calls[0]?.url).toContain("https://api.staging.internal/v1/instances?");
  });

  it("never discovers metros when an explicit endpoint is named", async () => {
    const { fetch, calls } = fakeFetch([ok({ instances: [{ uuid: "u1" }] })]);
    const ukc = new UnikraftCloud({ token: "t", baseUrl: "https://api.staging.internal", fetch });

    // The scope is "all" by default, but an explicit endpoint is the only one
    // there is: no /v1/metros lookup, no invented hostnames.
    await collect(ukc.instances.list());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("https://api.staging.internal/v1/instances?");
  });

  it("queries by uuid alone when given a uuid ref", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const { fetch, calls } = fakeFetch([ok({ instances: [{ uuid }] })]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    await ukc.instances.get({ uuid });

    const url = new URL(calls[0]?.url ?? "");
    expect(Object.fromEntries(url.searchParams)).toEqual({ uuid, details: "true" });
  });

  it("rejects a ref carrying neither uuid nor name", () => {
    // Unreachable from TypeScript; untyped JavaScript callers still get a clear
    // error rather than an empty filter the API would reject.
    expect(() => toQuery({} as never)).toThrow(TypeError);
  });

  it("throws UnikraftCloudError on non-2xx responses", async () => {
    const { fetch } = fakeFetch([
      { status: 404, body: { status: "error", op_time_us: 1, errors: [{ status: 404 }] } },
    ]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    await expect(ukc.instances.get({ name: "missing" })).rejects.toBeInstanceOf(UnikraftCloudError);
    await expect(ukc.instances.get({ name: "missing" })).rejects.toMatchObject({ status: 404 });
  });

  it("auto-paginates list() across pages", async () => {
    const first = Array.from({ length: 100 }, (_, n) => ({ uuid: `u${n}`, name: `i${n}` }));
    const second = [{ uuid: "u100", name: "i100" }];
    const { fetch, calls } = fakeFetch([ok({ instances: first }), ok({ instances: second })]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    const names: string[] = [];
    for await (const inst of ukc.instances.list()) names.push(inst.name ?? "");

    expect(names).toHaveLength(101);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain("from=u99");
  });

  it("update() still accepts raw patch items", async () => {
    const { fetch, calls } = fakeFetch([ok({ instances: [{ uuid: "u1", name: "web" }] })]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    await ukc.instances.update({ name: "web" }, [{ prop: "memory_mb", op: "set", value: 512 }]);

    expect(calls[0]?.init?.method).toBe("PATCH");
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body).toEqual([{ name: "web", prop: "memory_mb", op: "set", value: 512 }]);
  });

  it("history() filters by name/uuid via query and returns a list", async () => {
    const { fetch, calls } = fakeFetch([
      ok({ instances: [{ state: "running" }, { state: "stopped" }] }),
    ]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    const hist = await ukc.instances.history({ name: "web" });

    expect(hist).toHaveLength(2);
    expect(calls[0]?.url).toContain("/v1/instances/history?");
    expect(calls[0]?.url).toContain("name=web");
  });

  it("users.quotas() unwraps the quota list and tags the metro", async () => {
    const { fetch } = fakeFetch([ok({ quotas: [{ used: 1 }] })]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    const quotas = await ukc.users.quotas();

    expect(quotas).toEqual([{ used: 1, metro: "fra" }]);
  });

  it("does not inject a proxy dispatcher when a custom fetch is supplied", async () => {
    // A custom fetch owns transport; env-proxy injection is suppressed because a
    // standalone-undici dispatcher is incompatible with a foreign fetch.
    const prev = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = "http://127.0.0.1:8080";
    try {
      const { fetch, calls } = fakeFetch([ok({ instances: [{ uuid: "u1" }] })]);
      const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

      await ukc.instances.get({ name: "web" });
      expect((calls[0]?.init as { dispatcher?: unknown })?.dispatcher).toBeUndefined();
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "HTTP_PROXY");
      else process.env.HTTP_PROXY = prev;
    }
  });

  it("does not consult proxy env vars when proxyFromEnv is false", async () => {
    const prev = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = "http://127.0.0.1:8080";
    try {
      const { fetch, calls } = fakeFetch([ok({ instances: [{ uuid: "u1" }] })]);
      const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch, proxyFromEnv: false });

      await ukc.instances.get({ name: "web" });
      expect((calls[0]?.init as { dispatcher?: unknown })?.dispatcher).toBeUndefined();
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "HTTP_PROXY");
      else process.env.HTTP_PROXY = prev;
    }
  });

  it("create() passes an image string through untouched", async () => {
    const { fetch, calls } = fakeFetch([ok({ instances: [{ uuid: "u1", name: "web" }] })]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    await ukc.instances.create({ image: "nginx:latest", memory_mb: 256 });

    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body).toEqual({ image: "nginx:latest", memory_mb: 256 });
  });

  it("create() passes a structured ImageSpec through untouched", async () => {
    const { fetch, calls } = fakeFetch([ok({ instances: [{ uuid: "u1" }] })]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    await ukc.instances.create({ image: { url: "nginx:latest", credentials: "tok" } });

    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body).toEqual({ image: { url: "nginx:latest", credentials: "tok" } });
  });

  it("list() throws when a 200 envelope reports a logical error", async () => {
    const { fetch } = fakeFetch([
      { body: { status: "error", op_time_us: 1, message: "nope", errors: [{ status: 500 }] } },
    ]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    // Must throw rather than silently yielding an empty page.
    await expect(collect(ukc.instances.list())).rejects.toBeInstanceOf(UnikraftCloudError);
  });

  it("logs() passes options as query params and sends no GET body", async () => {
    const { fetch, calls } = fakeFetch([ok({ instances: [{ output: "hello" }] })]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    await ukc.instances.logs({ name: "web" }, { offset: -4096, limit: 4096 });

    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/instances/log");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      name: "web",
      offset: "-4096",
      limit: "4096",
    });
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it("wait() passes state and timeout as query params", async () => {
    const { fetch, calls } = fakeFetch([ok({ instances: [{ state: "running" }] })]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    await ukc.instances.wait({ name: "web" }, { state: "running", timeoutSeconds: 30 });

    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/instances/wait");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      name: "web",
      state: "running",
      timeout_s: "30",
    });
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it("sends a bulk delete body of refs", async () => {
    const { fetch, calls } = fakeFetch([ok({ instances: [{ uuid: "u1" }, { uuid: "u2" }] })]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    await ukc.instances.delete([{ name: "web" }, { uuid: "550e8400-e29b-41d4-a716-446655440000" }]);

    // One metro in scope: no lookups, one bulk call.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe("DELETE");
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body).toEqual([{ name: "web" }, { uuid: "550e8400-e29b-41d4-a716-446655440000" }]);
  });
});

describe("the two layers", () => {
  it("exposes the raw platform API under ukc.api.platform", async () => {
    const { fetch, calls } = fakeFetch([ok({ instances: [{ uuid: "u1" }] })]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    const res = await ukc.api.platform.instances.getInstances({ count: 10, details: true });

    // The raw layer hands back the envelope untouched.
    expect(res.status).toBe("success");
    expect(res.op_time_us).toBe(1);
    expect(res.data?.instances).toEqual([{ uuid: "u1" }]);
    expect(calls[0]?.url).toContain("https://api.fra.unikraft.cloud/v1/instances?");
  });

  it("keeps a per-resource escape hatch on the idiomatic client", async () => {
    const { fetch } = fakeFetch([ok({ instances: [{ uuid: "u1" }] })]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    const res = await ukc.instances.api.getInstances({ count: 1 });

    expect(res.data?.instances).toEqual([{ uuid: "u1" }]);
  });

  it("pins the raw platform API to a scoped metro", async () => {
    const { fetch, calls } = fakeFetch([ok({ instances: [] })]);
    const ukc = new UnikraftCloud({ token: "t", fetch });

    await ukc.metro("dal").api.platform.instances.getInstances({});

    expect(calls[0]?.url).toContain("https://api.dal.unikraft.cloud/v1/instances");
  });

  it("routes control-plane calls to the global endpoint", async () => {
    const { fetch, calls } = fakeFetch([ok({ metros: [{ name: "fra" }] })]);
    const ukc = new UnikraftCloud({ token: "t", metro: "dal", fetch });

    await ukc.api.controlplane.metros.listMetros();

    expect(calls[0]?.url).toBe("https://controlplane.unikraft.cloud/v1/metros");
  });

  it("reaches the unwrapped autoscale plumbing", async () => {
    const { fetch, calls } = fakeFetch([ok({ service_groups: [{ uuid: "sg1" }] })]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    const res = await ukc.api.platform.autoscale.getAutoscaleConfigurations({ uuid: ["sg1"] });

    expect(res.data?.service_groups).toEqual([{ uuid: "sg1" }]);
    expect(calls[0]?.url).toContain("/v1/services/autoscale?");
  });

  it("caches the client returned for a metro", () => {
    const { fetch } = fakeFetch([ok({})]);
    const ukc = new UnikraftCloud({ token: "t", fetch });

    expect(ukc.metro("fra")).toBe(ukc.metro("fra"));
    expect(ukc.metro("fra")).not.toBe(ukc.metro("dal"));
  });
});

describe("metro scope", () => {
  it("discovers metros and merges list() across all of them", async () => {
    const { fetch, calls } = routedFetch((url) => {
      if (url.pathname === "/v1/metros") return { body: metrosBody(["fra", "dal", "sin"]) };
      const metro = metroOf(url);
      return { body: okBody({ instances: [{ uuid: `u-${metro}`, name: `web-${metro}` }] }) };
    });
    const ukc = new UnikraftCloud({ token: "t", fetch });

    const found = await collect(ukc.instances.list({ details: true }));

    expect(found.map((i) => `${i.metro}:${i.name}`).sort()).toEqual([
      "dal:web-dal",
      "fra:web-fra",
      "sin:web-sin",
    ]);
    // One discovery call, then one per metro.
    expect(calls.filter((c) => c.url.includes("/v1/metros"))).toHaveLength(1);
    expect(calls).toHaveLength(4);
  });

  it("discovers metros only once per client", async () => {
    const { fetch, calls } = routedFetch((url) => {
      if (url.pathname === "/v1/metros") return { body: metrosBody(["fra", "dal"]) };
      return { body: okBody({ instances: [] }) };
    });
    const ukc = new UnikraftCloud({ token: "t", fetch });

    await collect(ukc.instances.list());
    await collect(ukc.volumes.list());

    expect(calls.filter((c) => c.url.includes("/v1/metros"))).toHaveLength(1);
  });

  it("skips discovery when the metros are named per call", async () => {
    const { fetch, calls } = routedFetch(() => ({ body: okBody({ instances: [] }) }));
    const ukc = new UnikraftCloud({ token: "t", fetch });

    await collect(ukc.instances.list({ metros: ["fra", "dal"] }));

    expect(calls.filter((c) => c.url.includes("/v1/metros"))).toHaveLength(0);
    expect(calls.map((c) => new URL(c.url).hostname).sort()).toEqual([
      "api.dal.unikraft.cloud",
      "api.fra.unikraft.cloud",
    ]);
  });

  it("yields every healthy metro's results, then throws for the failures", async () => {
    const { fetch } = routedFetch((url) => {
      if (url.pathname === "/v1/metros") return { body: metrosBody(["fra", "dal", "sin"]) };
      const metro = metroOf(url);
      if (metro === "sin") {
        return { status: 503, body: { status: "error", op_time_us: 1, errors: [{ status: 503 }] } };
      }
      return { body: okBody({ instances: [{ uuid: `u-${metro}`, name: metro }] }) };
    });
    const ukc = new UnikraftCloud({ token: "t", fetch });

    const seen: string[] = [];
    const err = await (async () => {
      try {
        for await (const inst of ukc.instances.list()) seen.push(inst.metro);
        return undefined;
      } catch (e) {
        return e;
      }
    })();

    // The healthy metros are delivered before the aggregate failure is raised.
    expect(seen.sort()).toEqual(["dal", "fra"]);
    expect(err).toBeInstanceOf(MetroFanoutError);
    expect((err as MetroFanoutError).message).toContain("1 of 3 metros failed: sin (503)");
    expect((err as MetroFanoutError).failures.map((f) => f.metro)).toEqual(["sin"]);
    expect((err as MetroFanoutError).status).toBe(503);
  });

  it("stops the remaining metros when the consumer breaks early", async () => {
    const { fetch, calls } = routedFetch((url) => {
      if (url.pathname === "/v1/metros") return { body: metrosBody(["fra", "dal"]) };
      const metro = metroOf(url);
      return { body: okBody({ instances: [{ uuid: `u-${metro}` }] }) };
    });
    const ukc = new UnikraftCloud({ token: "t", fetch });

    for await (const _inst of ukc.instances.list()) break;

    // Discovery + at most one page per metro; no further pages are requested.
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  it("locates a resource across metros and acts only on the one that holds it", async () => {
    const { fetch, calls } = routedFetch((url) => {
      if (url.pathname === "/v1/metros") return { body: metrosBody(["fra", "dal", "sin"]) };
      if (url.pathname === "/v1/instances/suspend") {
        return { body: okBody({ instances: [{ uuid: "u1", name: "web", state: "standby" }] }) };
      }
      const metro = metroOf(url);
      return {
        body: okBody({ instances: metro === "dal" ? [{ uuid: "u1", name: "web" }] : [] }),
      };
    });
    const ukc = new UnikraftCloud({ token: "t", fetch });

    const suspended = await ukc.instances.get({ name: "web" }).suspend();

    expect(suspended.state).toBe("standby");
    expect(suspended.metro).toBe("dal");
    const suspends = calls.filter((c) => c.url.includes("/v1/instances/suspend"));
    expect(suspends).toHaveLength(1);
    expect(suspends[0]?.url).toContain("https://api.dal.unikraft.cloud");
  });

  it("groups a bulk operation by every metro a name matches in", async () => {
    // The same name in several metros is normal — one service deployed widely —
    // so a bulk operation acts on all of them, bounded by the scope.
    const { fetch, calls } = routedFetch((url) => {
      if (url.pathname === "/v1/metros") return { body: metrosBody(["fra", "dal", "sin"]) };
      const metro = metroOf(url);
      if (url.searchParams.has("name")) {
        return {
          body: okBody({ instances: metro === "sin" ? [] : [{ uuid: `u-${metro}`, name: "web" }] }),
        };
      }
      return { body: okBody({ instances: [{ uuid: `u-${metro}` }] }) };
    });
    const ukc = new UnikraftCloud({ token: "t", fetch });

    await ukc.instances.delete([{ name: "web" }]);

    const deletes = calls.filter((c) => c.init?.method === "DELETE");
    expect(deletes.map((c) => new URL(c.url).hostname).sort()).toEqual([
      "api.dal.unikraft.cloud",
      "api.fra.unikraft.cloud",
    ]);
    for (const call of deletes) {
      expect(JSON.parse(call.init?.body as string)).toEqual([{ name: "web" }]);
    }
  });

  it("reports a resource missing everywhere as a 404 naming the metros searched", async () => {
    const { fetch } = routedFetch((url) => {
      if (url.pathname === "/v1/metros") return { body: metrosBody(["fra", "dal"]) };
      return { body: okBody({ instances: [] }) };
    });
    const ukc = new UnikraftCloud({ token: "t", fetch });

    await expect(ukc.instances.get({ name: "nope" })).rejects.toMatchObject({
      status: 404,
      message: 'instance name "nope" not found in fra, dal',
    });
  });

  it("groups a bulk operation by the metro each ref lives in", async () => {
    const { fetch, calls } = routedFetch((url) => {
      if (url.pathname === "/v1/metros") return { body: metrosBody(["fra", "dal"]) };
      const metro = metroOf(url);
      if (url.pathname === "/v1/instances" && url.searchParams.has("name")) {
        const name = url.searchParams.get("name");
        const here = (metro === "fra" && name === "a") || (metro === "dal" && name === "b");
        return { body: okBody({ instances: here ? [{ uuid: `u-${name}`, name }] : [] }) };
      }
      return { body: okBody({ instances: [{ uuid: `u-${metro}` }] }) };
    });
    const ukc = new UnikraftCloud({ token: "t", fetch });

    await ukc.instances.delete([{ name: "a" }, { name: "b" }]);

    const deletes = calls.filter((c) => c.init?.method === "DELETE");
    expect(deletes).toHaveLength(2);
    const byMetro = Object.fromEntries(
      deletes.map((c) => [
        new URL(c.url).hostname,
        JSON.parse(c.init?.body as string) as Array<{ name?: string }>,
      ]),
    );
    expect(byMetro["api.fra.unikraft.cloud"]).toEqual([{ name: "a" }]);
    expect(byMetro["api.dal.unikraft.cloud"]).toEqual([{ name: "b" }]);
  });

  it("creates in the default metro when the scope spans all of them", async () => {
    const { fetch, calls } = routedFetch(() => ({
      body: okBody({ instances: [{ uuid: "u1", name: "web" }] }),
    }));
    const ukc = new UnikraftCloud({ token: "t", fetch });

    const created = await ukc.instances.create({ image: "nginx:latest" });

    // Creation cannot mean "everywhere", so it targets the default metro and
    // needs no discovery.
    expect(created.metro).toBe("fra");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("https://api.fra.unikraft.cloud/v1/instances");
  });

  it("honours a per-call metro override on create", async () => {
    const { fetch, calls } = routedFetch(() => ({
      body: okBody({ instances: [{ uuid: "u1", name: "web" }] }),
    }));
    const ukc = new UnikraftCloud({ token: "t", fetch });

    const created = await ukc.instances.create({ image: "nginx:latest" }, { metros: "sfo" });

    expect(created.metro).toBe("sfo");
    expect(calls[0]?.url).toContain("https://api.sfo.unikraft.cloud/v1/instances");
  });

  it("merges quotas from every metro", async () => {
    const { fetch } = routedFetch((url) => {
      if (url.pathname === "/v1/metros") return { body: metrosBody(["fra", "dal"]) };
      return { body: okBody({ quotas: [{ used: metroOf(url) === "fra" ? 1 : 2 }] }) };
    });
    const ukc = new UnikraftCloud({ token: "t", fetch });

    const quotas = await ukc.users.quotas();

    expect(
      quotas.map((q) => `${q.metro}:${(q as unknown as { used: number }).used}`).sort(),
    ).toEqual(["dal:2", "fra:1"]);
  });

  it("explains itself when metro discovery fails", async () => {
    const { fetch } = routedFetch(() => ({
      status: 500,
      body: { status: "error", op_time_us: 1, errors: [{ status: 500 }] },
    }));
    const ukc = new UnikraftCloud({ token: "t", fetch });

    await expect(collect(ukc.instances.list())).rejects.toThrow(/Could not discover/);
  });
});

describe("chainable handles", () => {
  it("costs a single request when the metro is already known", async () => {
    const { fetch, calls } = fakeFetch([
      ok({ instances: [{ uuid: "u1", name: "web", state: "standby" }] }),
    ]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    const suspended = await ukc.instances.get({ name: "web" }).suspend();

    // No lookup: the caller said which metro, so only the suspend is sent.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/v1/instances/suspend");
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual([{ name: "web" }]);
    expect(suspended.metro).toBe("fra");
  });

  it("awaits to the resource itself when nothing is chained", async () => {
    const { fetch, calls } = fakeFetch([ok({ instances: [{ uuid: "u1", name: "web" }] })]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    const handle = ukc.instances.get({ name: "web" });
    const instance = await handle;

    expect(instance.name).toBe("web");
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/v1/instances");
    // Awaiting twice reuses the first read.
    await handle;
    expect(calls).toHaveLength(1);
  });

  it("runs chained operations in order", async () => {
    const { fetch, calls } = routedFetch((url) => {
      if (url.pathname === "/v1/instances/wait") {
        return { body: okBody({ instances: [{ uuid: "u1", state: "running" }] }) };
      }
      if (url.pathname === "/v1/instances/log") {
        return { body: okBody({ instances: [{ output: "aGk=" }] }) };
      }
      return { body: okBody({ instances: [{ uuid: "u1", name: "web" }] }) };
    });
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    const { output } = await ukc.instances
      .create({ image: "nginx:latest" })
      .wait({ state: "running" })
      .logs({ offset: -1024 });

    expect(output).toBe("aGk=");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/v1/instances",
      "/v1/instances/wait",
      "/v1/instances/log",
    ]);
  });

  it("reports which metro a handle resolved to", async () => {
    const { fetch } = fakeFetch([ok({ instances: [{ uuid: "u1" }] })]);
    const ukc = new UnikraftCloud({ token: "t", metro: "dal", fetch });

    expect(await ukc.instances.get({ name: "web" }).where()).toBe("dal");
  });

  it("chains volume attachment off a get", async () => {
    const { fetch, calls } = fakeFetch([ok({ volumes: [{ uuid: "v1", name: "data" }] })]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    await ukc.volumes.get({ name: "data" }).attach({ attach_to: { name: "web" }, at: "/data" });

    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/v1/volumes/attach");
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual([
      { name: "data", attach_to: { name: "web" }, at: "/data" },
    ]);
  });
});

describe("a name that exists in several metros", () => {
  /** Answers as if `web` exists in every metro. */
  const everywhere = (codes: string[]) =>
    routedFetch((url) => {
      if (url.pathname === "/v1/metros") return { body: metrosBody(codes) };
      const metro = metroOf(url);
      if (url.pathname === "/v1/instances/suspend") {
        return {
          body: okBody({ instances: [{ uuid: `u-${metro}`, name: "web", state: "standby" }] }),
        };
      }
      return { body: okBody({ instances: [{ uuid: `u-${metro}`, name: "web" }] }) };
    });

  it("makes get() report the ambiguity and carry the matches", async () => {
    const { fetch } = everywhere(["fra", "dal", "sin"]);
    const ukc = new UnikraftCloud({ token: "t", fetch });

    const err = await ukc.instances
      .get({ name: "web" })
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AmbiguousRefError);
    const ambiguous = err as AmbiguousRefError<{ uuid?: string }>;
    expect([...ambiguous.metros].sort()).toEqual(["dal", "fra", "sin"]);
    // The matches come with the error, so recovering costs no further requests.
    expect(ambiguous.matches).toHaveLength(3);
    expect(ambiguous.matches.map((m) => m.uuid).sort()).toEqual(["u-dal", "u-fra", "u-sin"]);
    expect(ambiguous.message).toContain('metro: "');
  });

  it("takes a metro-qualified ref with no lookup at all", async () => {
    const { fetch, calls } = everywhere(["fra", "dal", "sin"]);
    const ukc = new UnikraftCloud({ token: "t", fetch });

    const suspended = await ukc.instances.get({ name: "web", metro: "dal" }).suspend();

    expect(suspended.metro).toBe("dal");
    // No discovery, no search: one request, to the named metro.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("https://api.dal.unikraft.cloud/v1/instances/suspend");
    // `metro` says where to send the request; it must not leak into the body.
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual([{ name: "web" }]);
  });

  it("acts on every match through each()", async () => {
    const { fetch, calls } = everywhere(["fra", "dal", "sin"]);
    const ukc = new UnikraftCloud({ token: "t", fetch });

    const suspended = await ukc.instances.each({ name: "web" }).suspend();

    expect(suspended.map((s) => s.metro).sort()).toEqual(["dal", "fra", "sin"]);
    expect(suspended.every((s) => s.state === "standby")).toBe(true);
    expect(calls.filter((c) => c.url.includes("/v1/instances/suspend"))).toHaveLength(3);
  });

  it("reads and counts the matches of each()", async () => {
    const { fetch } = everywhere(["fra", "dal"]);
    const ukc = new UnikraftCloud({ token: "t", fetch });
    const web = ukc.instances.each({ name: "web" });

    expect(await web.size()).toBe(2);
    expect((await web.where()).sort()).toEqual(["dal", "fra"]);
    // The lookup is reused, so awaiting the set yields the instances already read.
    expect((await web).map((i) => i.uuid).sort()).toEqual(["u-dal", "u-fra"]);
  });

  it("applies a staged edit to every match", async () => {
    const { fetch, calls } = everywhere(["fra", "dal"]);
    const ukc = new UnikraftCloud({ token: "t", fetch });

    await ukc.instances.each({ name: "web" }).edit().set({ memory_mb: 512 }).apply();

    const patches = calls.filter((c) => c.init?.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect(JSON.parse(patches[0]?.init?.body as string)).toEqual([
      { name: "web", prop: "memory_mb", op: "set", value: 512 },
    ]);
  });

  it("reports which metros failed while keeping the successes", async () => {
    const { fetch } = routedFetch((url) => {
      if (url.pathname === "/v1/metros") return { body: metrosBody(["fra", "dal"]) };
      const metro = metroOf(url);
      if (url.pathname === "/v1/instances/suspend" && metro === "dal") {
        return { status: 503, body: { status: "error", op_time_us: 1, errors: [{ status: 503 }] } };
      }
      return { body: okBody({ instances: [{ uuid: `u-${metro}`, name: "web" }] }) };
    });
    const ukc = new UnikraftCloud({ token: "t", fetch });

    const err = (await ukc.instances
      .each({ name: "web" })
      .suspend()
      .catch((e: unknown) => e)) as MetroFanoutError & { results?: unknown[] };

    expect(err).toBeInstanceOf(MetroFanoutError);
    expect(err.failures.map((f) => f.metro)).toEqual(["dal"]);
    expect(err.results).toHaveLength(1);
  });

  it("resolves without a lookup when the scope is a single metro", async () => {
    const { fetch, calls } = everywhere(["fra", "dal"]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    await ukc.instances.each({ name: "web" }).suspend();

    // The scope already pins the metro, so there is nothing to search for.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("https://api.fra.unikraft.cloud/v1/instances/suspend");
  });

  it("qualifies volumes, services and certificates the same way", async () => {
    const { fetch, calls } = routedFetch((url) =>
      url.pathname.startsWith("/v1/volumes")
        ? { body: okBody({ volumes: [{ uuid: "v1", name: "data" }] }) }
        : url.pathname.startsWith("/v1/certificates")
          ? { body: okBody({ certificates: [{ uuid: "c1", name: "star" }] }) }
          : { body: okBody({ service_groups: [{ uuid: "sg1", name: "web" }] }) },
    );
    const ukc = new UnikraftCloud({ token: "t", fetch });

    await ukc.volumes.get({ name: "data", metro: "sin" }).update({ size_mb: 4096 });
    await ukc.services.get({ name: "web", metro: "was" }).delete();
    await ukc.certificates.get({ name: "star", metro: "sfo" }).delete();

    expect(calls.map((c) => new URL(c.url).hostname)).toEqual([
      "api.sin.unikraft.cloud",
      "api.was.unikraft.cloud",
      "api.sfo.unikraft.cloud",
    ]);
    for (const call of calls) {
      const body = JSON.parse(call.init?.body as string) as Array<Record<string, unknown>>;
      expect(body[0]).not.toHaveProperty("metro");
    }
  });
});

describe("updating a resource", () => {
  const patched = () => ok({ instances: [{ uuid: "u1", name: "web", state: "running" }] });

  /** The PATCH body of the first recorded call. */
  const bodyOf = (calls: Call[]) => JSON.parse(calls[0]?.init?.body as string);

  it("infers `set` for each property of a patch object", async () => {
    const { fetch, calls } = fakeFetch([patched()]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    await ukc.instances.get({ name: "web" }).update({ memory_mb: 512, vcpus: 2 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(bodyOf(calls)).toEqual([
      { name: "web", prop: "memory_mb", op: "set", value: 512 },
      { name: "web", prop: "vcpus", op: "set", value: 2 },
    ]);
  });

  it("reads `null` as removing the whole property, and skips `undefined`", async () => {
    const { fetch, calls } = fakeFetch([patched()]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    await ukc.instances
      .get({ name: "web" })
      .update({ tags: null, autokill: null, hostname: undefined, memory_mb: 512 });

    expect(bodyOf(calls)).toEqual([
      // A `del` carries no value, and the undefined property produced no item.
      { name: "web", prop: "tags", op: "del" },
      { name: "web", prop: "autokill", op: "del" },
      { name: "web", prop: "memory_mb", op: "set", value: 512 },
    ]);
  });

  it("sends an image reference as given, string or structured", async () => {
    const { fetch, calls } = fakeFetch([patched()]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    // The API accepts either form, so neither is rewritten on the way out.
    await ukc.instances.update({ name: "web" }, { image: "nginx:1.27" });
    await ukc.instances.update({ name: "web" }, { image: { url: "nginx:1.27" } });

    expect(bodyOf(calls)).toEqual([{ name: "web", prop: "image", op: "set", value: "nginx:1.27" }]);
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual([
      { name: "web", prop: "image", op: "set", value: { url: "nginx:1.27" } },
    ]);
  });

  it("sends a staged edit as one request, in the order written", async () => {
    const { fetch, calls } = fakeFetch([patched()]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    const updated = await ukc.instances
      .get({ name: "web" })
      .edit()
      .set({ memory_mb: 512 })
      .add({ env: { LOG_LEVEL: "debug" }, tags: ["prod"] })
      .del({ env: ["OLD_FLAG"], schedules: null })
      .apply();

    expect(updated.metro).toBe("fra");
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls)).toEqual([
      { name: "web", prop: "memory_mb", op: "set", value: 512 },
      { name: "web", prop: "env", op: "add", value: { LOG_LEVEL: "debug" } },
      { name: "web", prop: "tags", op: "add", value: ["prod"] },
      { name: "web", prop: "env", op: "del", value: ["OLD_FLAG"] },
      { name: "web", prop: "schedules", op: "del" },
    ]);
  });

  it("refuses to apply an empty edit", () => {
    const { fetch } = fakeFetch([patched()]);
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    expect(() => ukc.instances.edit({ name: "web" }).apply()).toThrow(/no changes to apply/);
  });

  it("keeps chaining after an edit is applied", async () => {
    const { fetch, calls } = routedFetch((url) =>
      url.pathname === "/v1/instances/wait"
        ? { body: okBody({ instances: [{ uuid: "u1", state: "running" }] }) }
        : { body: okBody({ instances: [{ uuid: "u1", name: "web" }] }) },
    );
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    await ukc.instances.edit({ name: "web" }).set({ memory_mb: 512 }).apply().wait();

    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/v1/instances",
      "/v1/instances/wait",
    ]);
  });

  it("routes an edit to the metro that holds the instance", async () => {
    const { fetch, calls } = routedFetch((url) => {
      if (url.pathname === "/v1/metros") return { body: metrosBody(["fra", "dal"]) };
      const metro = metroOf(url);
      if (url.searchParams.has("name")) {
        return {
          body: okBody({ instances: metro === "dal" ? [{ uuid: "u1", name: "web" }] : [] }),
        };
      }
      return { body: okBody({ instances: [{ uuid: "u1", name: "web" }] }) };
    });
    const ukc = new UnikraftCloud({ token: "t", fetch });

    await ukc.instances
      .get({ name: "web" })
      .edit()
      .add({ tags: ["prod"] })
      .apply();

    const patches = calls.filter((c) => c.init?.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toContain("https://api.dal.unikraft.cloud");
  });

  it("patches volumes and service groups the same way", async () => {
    const { fetch, calls } = routedFetch((url) =>
      url.pathname === "/v1/volumes"
        ? { body: okBody({ volumes: [{ uuid: "v1", name: "data" }] }) }
        : { body: okBody({ service_groups: [{ uuid: "sg1", name: "web" }] }) },
    );
    const ukc = new UnikraftCloud({ token: "t", metro: "fra", fetch });

    await ukc.volumes.get({ name: "data" }).update({ size_mb: 2048 });
    await ukc.services.get({ name: "web" }).edit().set({ hard_limit: 20 }).apply();

    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual([
      { name: "data", prop: "size_mb", op: "set", value: 2048 },
    ]);
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual([
      { name: "web", prop: "hard_limit", op: "set", value: 20 },
    ]);
  });
});

describe("server-sent event operations", () => {
  /** Build a fake fetch that streams `chunks` back as a `text/event-stream`. */
  function sseFetch(chunks: string[], status = 200): { fetch: FetchLike; calls: Call[] } {
    const calls: Call[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
    };
    return { fetch, calls };
  }

  const pending = { status: "pending", op_time_us: 1 };
  const granted = { status: "success", op_time_us: 2, data: { token: "tok" } };

  it("checkAuthorization() yields one value per event", async () => {
    const last = JSON.stringify(granted);
    const { fetch, calls } = sseFetch([
      // A comment line is a keep-alive and carries no data; the final event is
      // split across chunks and arrives without a trailing blank line.
      `: keep-alive\n\ndata: ${JSON.stringify(pending)}\n\ndata: ${last.slice(0, 12)}`,
      last.slice(12),
    ]);
    const ukc = new UnikraftCloud({ token: "t", fetch });

    const events = await collect(
      ukc.api.controlplane.auth.checkAuthorization({ body: { request_id: "r1" } }),
    );

    expect(events).toEqual([pending, granted]);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.accept).toBe("text/event-stream");
    expect(calls[0]?.url).toBe("https://controlplane.unikraft.cloud/v1/auth/check");
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ request_id: "r1" });
  });

  it("throws on a non-2xx event-stream response", async () => {
    const { fetch } = sseFetch(
      [
        JSON.stringify({
          status: "error",
          op_time_us: 1,
          message: "denied",
          errors: [{ status: 401 }],
        }),
      ],
      401,
    );
    const ukc = new UnikraftCloud({ token: "t", fetch });

    const stream = ukc.api.controlplane.auth.checkAuthorization({ body: { request_id: "r1" } });
    await expect(collect(stream)).rejects.toMatchObject({ status: 401, message: "denied" });
  });

  it("reports malformed event payloads as a parse error", async () => {
    const { fetch } = sseFetch(["data: not-json\n\n"]);
    const ukc = new UnikraftCloud({ token: "t", fetch });

    const stream = ukc.api.controlplane.auth.checkAuthorization({ body: { request_id: "r1" } });
    await expect(collect(stream)).rejects.toMatchObject({ kind: "parse", body: "not-json" });
  });
});
