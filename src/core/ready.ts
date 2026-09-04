// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// Asking a service repeatedly whether it is ready yet.
//
// This module owns the mechanism only: the backoff, the deadline, the
// cancellation and, most importantly, which failures are worth asking again
// about. What to ask, and what to say when the answer never comes, belong to
// the caller.

import { UnikraftCloudError } from "./http.js";

/**
 * How long to keep asking, and how fast.
 *
 * @example
 * await sandbox.ready({ timeoutMs: 10_000 });
 * await sandbox.ready({ signal: controller.signal });
 */
export interface ReadyPolicy {
  /** First delay between probes, in milliseconds (default 100). */
  initialDelayMs?: number;
  /** Upper bound on the delay between probes, in milliseconds (default 2000). */
  maxDelayMs?: number;
  /** Give up after this long, in milliseconds (default 60000). */
  timeoutMs?: number;
  /** Abort the wait — the in-flight probe included. */
  signal?: AbortSignal;
}

/** The values {@link waitUntilReady} uses for anything the policy leaves out. */
export const READY_DEFAULTS = {
  initialDelayMs: 100,
  maxDelayMs: 2_000,
  timeoutMs: 60_000,
} as const satisfies Required<Omit<ReadyPolicy, "signal">>;

/**
 * The HTTP statuses worth probing again for.
 *
 * `502`/`503`/`504` are a proxy that has nothing to forward to yet. `404` is
 * the plugin route itself not being registered yet, which is plausible while
 * the instance boots — the platform has no distinct status for it.
 *
 * Everything else is final, and `401`/`403` especially so: retrying a rejected
 * token would turn "unauthorized" into a 60-second timeout, and hide the one
 * error whose fix the caller could act on.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([404, 502, 503, 504]);

/** Whether a failed probe says "not yet" rather than "no". */
export function isRetryableReadyError(err: unknown): boolean {
  if (!(err instanceof UnikraftCloudError)) return false;
  // A refused connection, a reset, a DNS miss: the instance is still coming up.
  if (err.kind === "network") return true;
  if (err.kind !== "http") return false;
  return err.status !== undefined && RETRYABLE_STATUSES.has(err.status);
}

/** How a timeout describes itself, and how it finds out what went wrong. */
export interface ReadyReport {
  /** The subject of the timeout message, e.g. `sandbox <uuid>`. */
  what?: string;
  /**
   * Asked once, and only after the deadline passes: return a phrase naming the
   * real cause, which is appended to the timeout message. A sandbox uses it to
   * read the instance's state, so a virtual machine that never started says so
   * instead of reporting a silent plugin.
   */
  diagnose?: (lastError: unknown) => Promise<string | undefined>;
}

/** Wait for `ms`, rejecting with the signal's reason if it aborts first. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    // `timer` is read only from a deferred callback, so the cycle is fine.
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Probe until it succeeds, and return once it does.
 *
 * @param probe What to ask. It should be cheap, idempotent, and answer as soon
 *   as the service is usable.
 * @param policy Backoff, deadline and cancellation.
 * @param report The subject of the timeout message, and an optional
 *   {@link ReadyReport.diagnose} that is asked *why* once the deadline passes.
 *
 * @example
 * await waitUntilReady(() => api.commands.listCommands());
 *
 * // With a deadline, a way out, and a subject for the timeout message.
 * await waitUntilReady(
 *   () => api.commands.listCommands(),
 *   { timeoutMs: 10_000, signal },
 *   { what: `sandbox ${uuid}` },
 * );
 */
export async function waitUntilReady(
  probe: () => Promise<unknown>,
  policy: ReadyPolicy = {},
  report: ReadyReport = {},
): Promise<void> {
  const what = report.what ?? "the service";
  const initialDelayMs = policy.initialDelayMs ?? READY_DEFAULTS.initialDelayMs;
  const maxDelayMs = policy.maxDelayMs ?? READY_DEFAULTS.maxDelayMs;
  const timeoutMs = policy.timeoutMs ?? READY_DEFAULTS.timeoutMs;
  const signal = policy.signal;

  const started = Date.now();
  const deadline = started + timeoutMs;
  let delay = Math.max(1, initialDelayMs);
  let attempts = 0;
  let lastError: unknown;

  for (;;) {
    signal?.throwIfAborted();
    attempts += 1;
    try {
      await probe();
      return;
    } catch (err) {
      // An abort surfaces as a network failure from `fetch`, which would
      // otherwise look retryable; the caller's intent wins over the symptom.
      signal?.throwIfAborted();
      if (!isRetryableReadyError(err)) throw err;
      lastError = err;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // "It did not answer" is rarely the useful half of the story. Give the
      // caller the chance to say what was actually wrong — the diagnosis costs
      // a request, and only on the path that has already failed.
      let why: string | undefined;
      try {
        why = await report.diagnose?.(lastError);
      } catch {
        // A failed diagnosis must not replace the timeout it was explaining.
      }
      throw new UnikraftCloudError(
        `${what} was not ready within ${timeoutMs} ms (${attempts} ${
          attempts === 1 ? "probe" : "probes"
        })${why ? `: ${why}` : ""}. The last attempt failed with: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
        // Deliberately no `status`: the deadline failed, not any one request.
        // Carrying the last probe's 404 here would make this error look like a
        // missing resource, which `orAbsent()` turns into `undefined`. The last
        // error stays reachable as `cause`.
        { kind: "timeout", cause: lastError },
      );
    }

    // Jitter over the lower half of the window, so a fleet of sandboxes created
    // together does not probe in lockstep.
    const window = Math.min(delay, maxDelayMs);
    await sleep(Math.min(window / 2 + Math.random() * (window / 2), remaining), signal);
    delay = Math.min(delay * 2, maxDelayMs);
  }
}
