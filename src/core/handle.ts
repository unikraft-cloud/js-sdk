// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// The chainable resource handle. Single-resource operations return a handle
// rather than a promise, so calls compose:
//
//   await ukc.instances.get({ name: "web" }).suspend();
//
// A handle is still awaitable — it implements PromiseLike — so awaiting one
// yields the resource itself, exactly as a plain promise-returning `get()`
// would.

import type { Metro, MetroEndpoint } from "./metro.js";
import type { Ref } from "./response.js";

/** A resource pinned to the metro that actually holds it. */
export interface MetroTarget extends MetroEndpoint {
  /** The reference (`{ name }` or `{ uuid }`) the operation was given. */
  ref: Ref;
}

/**
 * The outcome of locating a resource. A scope spanning several metros has to
 * ask them to find out which one holds the resource, and that answer already
 * contains the resource — so it is carried here instead of being fetched twice.
 */
export interface Located<T> {
  target: MetroTarget;
  value?: T;
}

/** How a handle resolves its target and its value. */
export interface HandleSteps<T> {
  /** Work out which metro holds the resource (may perform a request). */
  locate: () => Promise<Located<T>>;
  /** Produce the handle's value, once located. */
  fetch: (target: MetroTarget) => Promise<T>;
  /**
   * Whether a chained operation has to await this handle's own value first.
   * True for handles that represent an operation (`suspend()` must complete
   * before a chained `wait()` runs); false for a handle that merely identifies
   * a resource, which is what keeps `get(ref).suspend()` down to one request.
   */
  sequential?: boolean;
}

/**
 * A lazily-evaluated reference to one resource in one metro. Nothing is sent
 * until the handle is awaited or a chained operation runs, and each step is
 * performed at most once however many times it is awaited.
 */
export class ResourceHandle<T> implements PromiseLike<T> {
  readonly #steps: HandleSteps<T>;
  #located?: Promise<Located<T>>;
  #value?: Promise<T>;

  constructor(steps: HandleSteps<T>) {
    this.#steps = steps;
  }

  /** The resource's ref and the metro serving it, resolving the scope if needed. */
  resolve(): Promise<MetroTarget> {
    return this.#locate().then((located) => located.target);
  }

  /** Which metro holds this resource. */
  async where(): Promise<Metro> {
    return (await this.resolve()).metro;
  }

  // Being thenable is the point: it lets `await ukc.instances.get(ref)` return
  // the instance while `ukc.instances.get(ref).suspend()` keeps chaining.
  // biome-ignore lint/suspicious/noThenProperty: PromiseLike is deliberate here.
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.#evaluate().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T | TResult> {
    return this.#evaluate().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.#evaluate().finally(onfinally);
  }

  /**
   * The target a chained operation should act on, having first performed this
   * step if it is one. Subclasses call this when building the next handle.
   */
  protected next(): Promise<MetroTarget> {
    return this.#steps.sequential === true
      ? this.#evaluate().then(() => this.resolve())
      : this.resolve();
  }

  #locate(): Promise<Located<T>> {
    this.#located ??= this.#steps.locate();
    return this.#located;
  }

  #evaluate(): Promise<T> {
    this.#value ??= this.#locate().then((located) =>
      located.value !== undefined ? located.value : this.#steps.fetch(located.target),
    );
    return this.#value;
  }
}
