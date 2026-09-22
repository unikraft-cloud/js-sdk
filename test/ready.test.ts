// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnikraftCloudError } from "../src/core/http.js";
import { waitUntilReady } from "../src/core/ready.js";

// The waiter sleeps between probes, so the clock is faked: at real speed one
// default wait takes 60 seconds.
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const httpError = (status: number) =>
  new UnikraftCloudError(`HTTP ${status}`, { kind: "http", status });

const networkError = () =>
  new UnikraftCloudError("connect ECONNREFUSED 10.0.0.1:443", { kind: "network" });

/**
 * A probe that throws `error` for its first `failures` calls and then resolves,
 * recording the time of every call.
 */
function scriptedProbe({
  failures = Number.POSITIVE_INFINITY,
  error = httpError(503) as unknown,
} = {}) {
  const at: number[] = [];
  const probe = vi.fn(async () => {
    const failing = at.length < failures;
    at.push(Date.now());
    if (failing) throw error;
  });
  return { probe, at };
}

/**
 * A probe that never answers, and that ignores the signal it is given: the
 * waiter has to end the attempt on its own.
 */
function hungProbe() {
  let given: AbortSignal | undefined;
  const probe = vi.fn(async (signal: AbortSignal) => {
    given = signal;
    await new Promise(() => {});
  });
  return { probe, signalOf: () => given };
}

/**
 * Run a wait to its end on a fast-forwarded clock, and return the error it
 * rejected with, or `undefined` if it resolved. The handlers are attached
 * before the clock moves, so a rejection is never reported as unhandled.
 */
function settle(promise: Promise<void>, ms = 120_000): Promise<unknown> {
  const outcome = promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  return vi.advanceTimersByTimeAsync(ms).then(() => outcome);
}

/** The delays between consecutive probes, in milliseconds. */
const gapsOf = (at: readonly number[]) => at.slice(1).map((t, i) => t - (at[i] as number));

describe("waitUntilReady", () => {
  it("returns on the first probe when the service is already up", async () => {
    const { probe } = scriptedProbe({ failures: 0 });

    // The clock never moves here, so a wait that slept first would hang.
    await expect(waitUntilReady(probe)).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it.each([
    // The plugin route is not registered yet; the platform has no distinct
    // status for an instance that is still coming up.
    ["a 404", httpError(404)],
    ["a 502", httpError(502)],
    ["a 503", httpError(503)],
    ["a 504", httpError(504)],
    ["a refused connection", networkError()],
  ])("probes again after %s, then returns", async (_label, error) => {
    const { probe } = scriptedProbe({ failures: 1, error });

    await expect(settle(waitUntilReady(probe))).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it.each([
    // Retrying a rejected token turns "unauthorized" into a 60-second timeout
    // and hides the one error the caller can act on.
    ["a rejected token", httpError(401)],
    ["a forbidden token", httpError(403)],
    ["a server fault", httpError(500)],
    ["a malformed body", new UnikraftCloudError("bad body", { kind: "parse" })],
    ["a fault in the probe itself", new TypeError("cannot read properties of undefined")],
  ])("rethrows %s unchanged, without probing again", async (_label, error) => {
    const { probe } = scriptedProbe({ error });

    await expect(waitUntilReady(probe)).rejects.toBe(error);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("waits longer after each failure, up to the ceiling", async () => {
    const { probe, at } = scriptedProbe();

    await settle(
      waitUntilReady(probe, { initialDelayMs: 100, maxDelayMs: 800, timeoutMs: 10_000 }),
    );

    // Each delay is a random point inside a window that doubles from 100 ms and
    // stops at 800 ms, so the schedule is a range rather than fixed numbers.
    const gaps = gapsOf(at);
    expect(gaps[0]).toBeLessThanOrEqual(100);
    expect(Math.max(...gaps)).toBeGreaterThan(gaps[0] as number);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(800);
  });

  // The README promises callers a 60-second deadline, so the number is written
  // out here instead of read from READY_DEFAULTS: an assertion against the
  // constant moves with a changed default and can never fail.
  it("gives up after 60 s by default, with no probe past the deadline", async () => {
    const { probe, at } = scriptedProbe({ error: networkError() });

    const err = await settle(waitUntilReady(probe));

    const elapsed = (at.at(-1) as number) - (at[0] as number);
    expect(elapsed).toBeGreaterThan(58_000);
    expect(elapsed).toBeLessThanOrEqual(60_000);
    expect((err as UnikraftCloudError).message).toContain("within 60000 ms");
  });

  it("gives up on a probe that never answers, and stops it", async () => {
    const { probe, signalOf } = hungProbe();

    const err = await settle(waitUntilReady(probe, { timeoutMs: 5_000 }, { what: "sandbox abc" }));

    expect(probe).toHaveBeenCalledTimes(1);
    // The deadline reaches the request itself, not only the loop around it.
    expect(signalOf()?.aborted).toBe(true);
    expect(err).toBeInstanceOf(UnikraftCloudError);
    expect(err).toMatchObject({ kind: "timeout" });
    expect((err as UnikraftCloudError).message).toBe(
      "sandbox abc was not ready within 5000 ms (1 probe). The last probe never answered.",
    );
  });

  it("reports the subject, the deadline, the probe count and the last failure", async () => {
    // A last 404 also proves the timeout carries no `status`: `orAbsent()` turns
    // a 404 into `undefined`, and a wait that ran out of time is not absence.
    const last = httpError(404);
    const { probe } = scriptedProbe({ error: last });

    // A zero deadline leaves no room for a second probe.
    const err = await settle(waitUntilReady(probe, { timeoutMs: 0 }, { what: "sandbox abc" }));

    expect(err).toMatchObject({ kind: "timeout", cause: last, status: undefined });
    expect((err as UnikraftCloudError).message).toBe(
      "sandbox abc was not ready within 0 ms (1 probe). The last attempt failed with: HTTP 404",
    );
  });

  describe("diagnosis", () => {
    const timedOut = "the service was not ready within 0 ms (1 probe)";
    const lastFailure = "The last attempt failed with: HTTP 503";

    it("appends the answer to the timeout message", async () => {
      const last = httpError(503);
      const { probe } = scriptedProbe({ error: last });
      const diagnose = vi.fn(async () => "the instance is in state 'stopped'");

      const err = await settle(waitUntilReady(probe, { timeoutMs: 0 }, { diagnose }));

      expect((err as UnikraftCloudError).message).toBe(
        `${timedOut}: the instance is in state 'stopped'. ${lastFailure}`,
      );
      // One request, asked once, on the path that has already failed.
      expect(diagnose).toHaveBeenCalledTimes(1);
      expect(diagnose).toHaveBeenCalledWith(last);
    });

    it("keeps the timeout when the diagnosis itself fails", async () => {
      const { probe } = scriptedProbe({ error: httpError(503) });
      const diagnose = async () => {
        throw httpError(500);
      };

      const err = await settle(waitUntilReady(probe, { timeoutMs: 0 }, { diagnose }));

      expect((err as UnikraftCloudError).message).toBe(`${timedOut}. ${lastFailure}`);
    });

    it("is not asked when the wait ends any other way", async () => {
      const diagnose = vi.fn(async () => "unused");
      const ready = scriptedProbe({ failures: 0 });
      const denied = scriptedProbe({ error: httpError(403) });

      await waitUntilReady(ready.probe, {}, { diagnose });
      await expect(waitUntilReady(denied.probe, {}, { diagnose })).rejects.toMatchObject({
        status: 403,
      });

      expect(diagnose).not.toHaveBeenCalled();
    });
  });

  describe("cancellation", () => {
    const reason = new Error("the caller moved on");

    it("does not probe at all when the signal is already aborted", async () => {
      const { probe } = scriptedProbe({ failures: 0 });
      const controller = new AbortController();
      controller.abort(reason);

      await expect(waitUntilReady(probe, { signal: controller.signal })).rejects.toBe(reason);
      expect(probe).not.toHaveBeenCalled();
    });

    it("stops mid-sleep and rejects with the abort reason", async () => {
      const { probe } = scriptedProbe();
      const controller = new AbortController();

      const promise = waitUntilReady(probe, { signal: controller.signal });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(reason);

      await expect(promise).rejects.toBe(reason);
      expect(probe).toHaveBeenCalledTimes(1);
      // The sleep is cleared on the way out, so no timer is left to fire.
      expect(vi.getTimerCount()).toBe(0);
    });

    it("aborts the probe in flight, not just the sleep between probes", async () => {
      const { probe, signalOf } = hungProbe();
      const controller = new AbortController();

      const promise = waitUntilReady(probe, { signal: controller.signal });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(reason);

      await expect(promise).rejects.toBe(reason);
      expect(signalOf()?.aborted).toBe(true);
      expect(signalOf()?.reason).toBe(reason);
    });

    it("reports the abort even when the deadline passed meanwhile", async () => {
      const controller = new AbortController();
      // An aborted `fetch` rejects as a network failure, which on its own looks
      // retryable, and the expired deadline would turn it into a timeout. The
      // caller asked to stop, so the abort is the answer.
      const probe = vi.fn(async () => {
        controller.abort(reason);
        throw networkError();
      });

      await expect(waitUntilReady(probe, { signal: controller.signal, timeoutMs: 0 })).rejects.toBe(
        reason,
      );
    });
  });

  // A duration the loop cannot use would poll flat out instead of waiting.
  describe("an unusable policy", () => {
    it.each([
      ["a NaN deadline", { timeoutMs: Number.NaN }],
      ["an endless deadline", { timeoutMs: Number.POSITIVE_INFINITY }],
      ["a deadline in the past", { timeoutMs: -1 }],
      ["a NaN first delay", { initialDelayMs: Number.NaN }],
      ["a delay ceiling of zero", { maxDelayMs: 0 }],
    ])("rejects %s without probing", async (_label, policy) => {
      const { probe } = scriptedProbe({ failures: 0 });

      await expect(waitUntilReady(probe, policy)).rejects.toThrow(RangeError);
      expect(probe).not.toHaveBeenCalled();
    });
  });
});
