// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// Acting on every metro that holds a name. Names are unique within a metro, not
// across them, so one name can legitimately refer to a resource in every metro —
// the same service deployed everywhere. `each(ref)` addresses all of them at
// once, deliberately, instead of forcing a choice between guessing and failing.

import { type MetroFailure, MetroFanoutError } from "./fanout.js";
import type { ResourceHandle } from "./handle.js";
import type { Metro } from "./metro.js";

/**
 * Every resource matching one ref, one per metro. Awaiting the set yields the
 * resources; calling an operation runs it against each metro concurrently and
 * returns one result per metro.
 *
 * If some metros fail, the successes are still returned on the thrown
 * {@link MetroFanoutError} as `err.results`.
 *
 * @example
 * const web = ukc.instances.each({ name: "web" });
 * await web.where();     // ["fra", "dal", "sin"]
 * await web.suspend();   // one result per metro, each tagged
 */
export class HandleSet<H extends ResourceHandle<T>, T> implements PromiseLike<T[]> {
  readonly #locate: () => Promise<H[]>;
  #handles?: Promise<H[]>;

  constructor(locate: () => Promise<H[]>) {
    this.#locate = locate;
  }

  /** The individual handles, one per metro holding the resource. */
  handles(): Promise<H[]> {
    this.#handles ??= this.#locate();
    return this.#handles;
  }

  /** The metros holding a match. */
  async where(): Promise<Metro[]> {
    const handles = await this.handles();
    return Promise.all(handles.map((handle) => handle.where()));
  }

  /** How many metros hold a match. */
  async size(): Promise<number> {
    return (await this.handles()).length;
  }

  // Thenable on purpose, like ResourceHandle: `await each(ref)` reads every
  // match, while `each(ref).suspend()` keeps addressing them as a set.
  // biome-ignore lint/suspicious/noThenProperty: PromiseLike is deliberate here.
  then<TResult1 = T[], TResult2 = never>(
    onfulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.all().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T[] | TResult> {
    return this.all().catch(onrejected);
  }

  /** Read every match. */
  all(): Promise<T[]> {
    return this.map((handle) => handle as PromiseLike<T>);
  }

  /**
   * Run one operation per metro concurrently, in the metro that holds each
   * match. Subclasses use this to expose the resource's own operations.
   */
  protected async map<R>(each: (handle: H) => PromiseLike<R>): Promise<R[]> {
    const handles = await this.handles();
    const outcomes = await Promise.all(
      handles.map(async (handle) => {
        // The handles are already located, so asking where each one lives costs
        // nothing and gives a failure the metro to be reported against.
        const metro = await handle.where();
        try {
          return { ok: true as const, metro, value: await each(handle) };
        } catch (error) {
          return { ok: false as const, metro, error };
        }
      }),
    );

    const results: R[] = [];
    const failures: MetroFailure[] = [];
    for (const outcome of outcomes) {
      if (outcome.ok) results.push(outcome.value);
      else failures.push({ metro: outcome.metro, error: outcome.error });
    }
    if (failures.length > 0) {
      const error = new MetroFanoutError(
        `${failures.length} of ${handles.length} metros failed: ${failures
          .map((failure) => failure.metro)
          .join(", ")}.`,
        failures,
      );
      (error as MetroFanoutError & { results?: R[] }).results = results;
      throw error;
    }
    return results;
  }
}
