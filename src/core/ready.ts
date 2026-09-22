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

/** Reject with the signal's reason when it aborts, and never settle otherwise. */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/**
 * Read one duration out of the policy, and fall back to the default for it.
 *
 * A value the loop cannot use would poll flat out instead of waiting: `NaN`
 * makes every comparison against the deadline false, and it reaches
 * `setTimeout` as a zero-delay timer. A throw names the bad option at the call
 * that passed it, which a clamped value would hide.
 */
function duration(policy: ReadyPolicy, name: keyof typeof READY_DEFAULTS, least: number): number {
  const value = policy[name];
  if (value === undefined) return READY_DEFAULTS[name];
  if (!Number.isFinite(value) || value < least) {
    throw new RangeError(
      `\`${name}\` must be a number of milliseconds, ${least} or more. Received ${value}.`,
    );
  }
  return value;
}

/**
 * Probe until it succeeds, and return once it does.
 *
 * @param probe What to ask. It should be cheap, idempotent, and answer as soon
 *   as the service is usable. It is given a signal that aborts on cancellation
 *   and on the deadline, and should forward it to the request it makes. The
 *   waiter abandons a probe that ignores the signal instead of stopping it.
 * @param policy Backoff, deadline and cancellation.
 * @param report The subject of the timeout message, and an optional
 *   {@link ReadyReport.diagnose} that is asked *why* once the deadline passes.
 *
 * @throws RangeError If a duration in the policy is not a usable number of
 *   milliseconds.
 *
 * @example
 * await waitUntilReady((signal) => api.commands.listCommands({ signal }));
 *
 * // With a deadline, a way out, and a subject for the timeout message.
 * await waitUntilReady(
 *   (signal) => api.commands.listCommands({ signal }),
 *   { timeoutMs: 10_000, signal },
 *   { what: `sandbox ${uuid}` },
 * );
 */
export async function waitUntilReady(
  probe: (signal: AbortSignal) => Promise<unknown>,
  policy: ReadyPolicy = {},
  report: ReadyReport = {},
): Promise<void> {
  const what = report.what ?? "the service";
  const initialDelayMs = duration(policy, "initialDelayMs", 1);
  const maxDelayMs = duration(policy, "maxDelayMs", 1);
  const timeoutMs = duration(policy, "timeoutMs", 0);
  const signal = policy.signal;

  const deadline = Date.now() + timeoutMs;
  let delay = initialDelayMs;
  let attempts = 0;
  let lastError: unknown;

  /** Build the error the deadline ends the wait with. The caller throws it. */
  const timedOut = async (): Promise<UnikraftCloudError> => {
    // "It did not answer" is rarely the useful half of the story. Give the
    // caller the chance to say what was actually wrong — the diagnosis costs a
    // request, and only on the path that has already failed.
    let why: string | undefined;
    try {
      why = await report.diagnose?.(lastError);
    } catch {
      // A failed diagnosis must not replace the timeout it was explaining.
    }
    const last =
      lastError === undefined
        ? "The last probe never answered."
        : `The last attempt failed with: ${
            lastError instanceof Error ? lastError.message : String(lastError)
          }`;
    return new UnikraftCloudError(
      `${what} was not ready within ${timeoutMs} ms (${attempts} ${
        attempts === 1 ? "probe" : "probes"
      })${why ? `: ${why}` : ""}. ${last}`,
      // Deliberately no `status`: the deadline failed, not any one request.
      // Carrying the last probe's 404 here would make this error look like a
      // missing resource, which `orAbsent()` turns into `undefined`. The last
      // error stays reachable as `cause`.
      { kind: "timeout", cause: lastError },
    );
  };

  // The deadline and the caller's cancellation both have to reach a probe that
  // is already in flight, because a probe that never answers would outlive
  // both. The controller carries them to the probe, and the race below ends the
  // attempt even when the probe ignores the signal it was given.
  const stop = new AbortController();
  const onCancel = () => stop.abort(signal?.reason);
  signal?.addEventListener("abort", onCancel, { once: true });
  const expiry = setTimeout(() => stop.abort(), timeoutMs);
  const stopped = aborted(stop.signal);
  // The race handles this rejection on every attempt, but the deadline can also
  // fall between two attempts, where no race listens for it. Without a handler
  // here, that rejection becomes an unhandled rejection.
  void stopped.catch(() => {});

  try {
    for (;;) {
      signal?.throwIfAborted();
      attempts += 1;
      try {
        await Promise.race([probe(stop.signal), stopped]);
        return;
      } catch (err) {
        // An abort surfaces as a network failure from `fetch`, which would
        // otherwise look retryable; the caller's intent wins over the symptom.
        signal?.throwIfAborted();
        // The deadline passed while this probe was pending. The probe rejected
        // because this waiter aborted it, so that error is not an answer from
        // the service, and the last real failure stays the one worth reporting.
        if (stop.signal.aborted) throw await timedOut();
        if (!isRetryableReadyError(err)) throw err;
        lastError = err;
      }

      const remaining = deadline - Date.now();
      if (remaining > 0) {
        // Jitter over the lower half of the window, so a fleet of sandboxes
        // created together does not probe in lockstep.
        const window = Math.min(delay, maxDelayMs);
        await sleep(Math.min(window / 2 + Math.random() * (window / 2), remaining), signal);
        delay = Math.min(delay * 2, maxDelayMs);
      }
      // The sleep above stops at the deadline at the latest, so the loop can
      // arrive here with no time left. A probe started now can only end the
      // wait the same way.
      if (Date.now() >= deadline) throw await timedOut();
    }
  } finally {
    clearTimeout(expiry);
    signal?.removeEventListener("abort", onCancel);
  }
}
