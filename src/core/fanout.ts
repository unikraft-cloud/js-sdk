// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// Running one operation across several metros and sewing the results back
// together. The platform API is metro-scoped, so an account-wide view means
// asking every metro and merging what comes back.

import { UnikraftCloudError } from "./http.js";
import type { Metro, MetroEndpoint, WithMetro } from "./metro.js";

/** One metro's failure within a multi-metro operation. */
export interface MetroFailure {
  /** The metro whose request failed. */
  metro: Metro;
  /** Whatever that metro's request rejected with. */
  error: unknown;
}

/**
 * Raised when a multi-metro operation could not be completed everywhere. The
 * results from the metros that *did* answer have already been delivered — an
 * iteration yields them before this is thrown — so a caller can treat the
 * failure as partial rather than losing the whole answer.
 */
export class MetroFanoutError extends UnikraftCloudError {
  /** Per-metro failures, in the order they occurred. */
  readonly failures: readonly MetroFailure[];

  constructor(message: string, failures: readonly MetroFailure[]) {
    // A single underlying failure is worth surfacing as the status, so callers
    // can keep matching on `err.status === 403`.
    const statuses = new Set(
      failures.map((f) => (f.error instanceof UnikraftCloudError ? f.error.status : undefined)),
    );
    super(message, {
      kind: "fanout",
      status: statuses.size === 1 ? [...statuses][0] : undefined,
      cause: failures[0]?.error,
      body: failures,
    });
    this.name = "MetroFanoutError";
    this.failures = failures;
  }
}

/**
 * Raised when a name matches in more than one metro and the operation can only
 * act on one of them. Names are unique within a metro, not across them — the
 * same name commonly exists in several — so this is a routine outcome, not a
 * broken state: qualify the ref with `metro`, narrow the scope, or use `each()`
 * to act on every match.
 *
 * The matches are attached, so recovering costs no further requests.
 */
export class AmbiguousRefError<T = unknown> extends UnikraftCloudError {
  /** The metros the name was found in. */
  readonly metros: readonly Metro[];
  /** The matching resources, each tagged with its metro. */
  readonly matches: ReadonlyArray<WithMetro<T>>;

  constructor(message: string, matches: ReadonlyArray<WithMetro<T>>) {
    super(message, { kind: "fanout", body: matches });
    this.name = "AmbiguousRefError";
    this.matches = matches;
    this.metros = matches.map((match) => match.metro);
  }
}

/** Describe a failure compactly, e.g. `sin (503)`. */
function describeFailure(failure: MetroFailure): string {
  const status = failure.error instanceof UnikraftCloudError ? failure.error.status : undefined;
  return status === undefined ? failure.metro : `${failure.metro} (${status})`;
}

/** Build the aggregate error for a partly-failed fan-out. */
export function fanoutError(
  attempted: number,
  failures: readonly MetroFailure[],
): MetroFanoutError {
  const detail = failures.map(describeFailure).join(", ");
  return new MetroFanoutError(
    `${failures.length} of ${attempted} metros failed: ${detail}`,
    failures,
  );
}

/** One step of one metro's iterator. */
type Step<T> =
  | { id: number; ok: true; result: IteratorResult<T> }
  | { id: number; ok: false; error: unknown };

/**
 * Iterate `each(endpoint)` for every endpoint concurrently, yielding items as
 * soon as any metro produces one — so a slow metro never holds up a fast one,
 * and the interleaving is arrival order rather than metro order.
 *
 * Failures do not stop the merge: every healthy metro is drained first, then a
 * single {@link MetroFanoutError} naming the failed metros is thrown. Breaking
 * out of the loop early cancels the remaining metros' iterators and throws
 * nothing.
 *
 * @example
 * for await (const inst of fanout(endpoints, (e) => pageInstances(e))) { ... }
 */
export async function* fanout<T>(
  endpoints: readonly MetroEndpoint[],
  each: (endpoint: MetroEndpoint) => AsyncIterable<T>,
): AsyncGenerator<T, void, void> {
  // Single metro: no merge bookkeeping, and failures propagate as themselves
  // rather than being wrapped in a fan-out error.
  if (endpoints.length === 1) {
    yield* each(endpoints[0] as MetroEndpoint);
    return;
  }

  interface Active {
    endpoint: MetroEndpoint;
    iterator: AsyncIterator<T>;
    step: Promise<Step<T>>;
  }

  const advance = (id: number, iterator: AsyncIterator<T>): Promise<Step<T>> =>
    iterator.next().then(
      (result): Step<T> => ({ id, ok: true, result }),
      (error): Step<T> => ({ id, ok: false, error }),
    );

  const active = new Map<number, Active>();
  endpoints.forEach((endpoint, id) => {
    const iterator = each(endpoint)[Symbol.asyncIterator]();
    active.set(id, { endpoint, iterator, step: advance(id, iterator) });
  });

  const failures: MetroFailure[] = [];
  try {
    while (active.size > 0) {
      const step = await Promise.race([...active.values()].map((a) => a.step));
      const entry = active.get(step.id);
      if (!entry) continue;

      if (!step.ok) {
        active.delete(step.id);
        failures.push({ metro: entry.endpoint.metro, error: step.error });
        continue;
      }
      if (step.result.done) {
        active.delete(step.id);
        continue;
      }

      // Queue this metro's next page before handing the item to the consumer,
      // so every metro stays in flight while the consumer works.
      entry.step = advance(step.id, entry.iterator);
      yield step.result.value;
    }
  } finally {
    // An early `break`/`throw` in the consumer lands here: release the metros
    // still in flight instead of leaving their requests dangling.
    for (const entry of active.values()) {
      const done = entry.iterator.return?.();
      if (done) void Promise.resolve(done).catch(() => {});
    }
  }

  if (failures.length > 0) throw fanoutError(endpoints.length, failures);
}

/** One metro's outcome from {@link fanoutSettled}. */
export type MetroOutcome<T> =
  | { endpoint: MetroEndpoint; ok: true; value: T }
  | { endpoint: MetroEndpoint; ok: false; error: unknown };

/**
 * Run `each(endpoint)` for every endpoint concurrently and report every
 * outcome, successes and failures alike. Used by single-resource operations,
 * which cannot yield partial results and so need to see the whole picture
 * before deciding what to throw.
 */
export function fanoutSettled<T>(
  endpoints: readonly MetroEndpoint[],
  each: (endpoint: MetroEndpoint) => Promise<T>,
): Promise<Array<MetroOutcome<T>>> {
  return Promise.all(
    endpoints.map((endpoint) =>
      each(endpoint).then(
        (value): MetroOutcome<T> => ({ endpoint, ok: true, value }),
        (error): MetroOutcome<T> => ({ endpoint, ok: false, error }),
      ),
    ),
  );
}
