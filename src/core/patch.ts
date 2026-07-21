// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// Updating a resource. The API models an update as a list of
// `{ prop, op, value }` triples with `value` typed `unknown` — precise on the
// wire, clunky to write and unchecked by the compiler. This turns that into two
// idiomatic forms:
//
//   update({ memory_mb: 512 })                    // a patch object; ops inferred
//   edit().set({...}).add({...}).del({...})       // ops stated outright
//
// Both compile down to the same triples, sent in one request.

/** The operations every mutable property supports. */
export type PatchOp = "set" | "add" | "del";

/** One `{ prop, op, value }` triple, as the API models an update. */
export interface PatchItem<P extends string = string> {
  prop: P;
  op: PatchOp;
  value?: unknown;
}

/**
 * A patch object: each property either takes a new value, or `null` to remove
 * the property altogether. Omitted (or `undefined`) properties are left alone.
 *
 * @example
 * { memory_mb: 512, hostname: "web-1", autokill: null }
 */
export type Patch<Props> = {
  [K in keyof Props]?: Props[K] | null;
};

/**
 * A deletion patch: properties that hold a collection accept the members to
 * remove (`{ env: ["LOG_LEVEL"] }`), and every property accepts `null` to
 * remove it wholesale.
 */
export type DeletePatch<Props, Members> = {
  [K in Exclude<keyof Props, keyof Members>]?: null;
} & {
  [K in keyof Members]?: Members[K] | null;
};

/** Rewrites a value on its way to the wire (e.g. `"nginx"` -> `{ url: ... }`). */
export type ValueNormaliser<P extends string> = (prop: P, value: unknown) => unknown;

/**
 * Turn a patch object into wire triples.
 *
 * `undefined` values are skipped, so spreading optional fields into a patch is
 * safe. `null` always means "remove this property", whichever method supplied
 * it — following JSON Merge Patch, where a null erases rather than assigns.
 */
export function toPatchItems<P extends string>(
  patch: object,
  op: PatchOp,
  normalise?: ValueNormaliser<P>,
): Array<PatchItem<P>> {
  const items: Array<PatchItem<P>> = [];
  for (const [key, value] of Object.entries(patch)) {
    const prop = key as P;
    if (value === undefined) continue;
    if (value === null) {
      // A bare `del` carries no value: the whole property goes.
      items.push({ prop, op: "del" });
      continue;
    }
    items.push({ prop, op, value: normalise ? normalise(prop, value) : value });
  }
  return items;
}

/**
 * A staged edit: chain `set`, `add` and `del`, then `apply()` to send every
 * change in one request. Each call appends, so the order you write is the order
 * the API receives.
 *
 * @example
 * await ukc.instances.get({ name: "web" }).edit()
 *   .set({ memory_mb: 512 })
 *   .add({ env: { LOG_LEVEL: "debug" } })
 *   .del({ tags: ["staging"] })
 *   .apply();
 */
export class ResourceEditor<P extends string, Props, Members, R> {
  readonly #items: Array<PatchItem<P>> = [];
  readonly #commit: (items: Array<PatchItem<P>>) => R;
  readonly #normalise?: ValueNormaliser<P>;
  readonly #what: string;

  constructor(
    commit: (items: Array<PatchItem<P>>) => R,
    what: string,
    normalise?: ValueNormaliser<P>,
  ) {
    this.#commit = commit;
    this.#what = what;
    this.#normalise = normalise;
  }

  /** Replace these properties' values. A `null` removes the property instead. */
  set(patch: Patch<Props>): this {
    this.#items.push(...toPatchItems<P>(patch as object, "set", this.#normalise));
    return this;
  }

  /** Merge into these properties, keeping what is already there. */
  add(patch: Partial<Props>): this {
    this.#items.push(...toPatchItems<P>(patch as object, "add", this.#normalise));
    return this;
  }

  /**
   * Remove members from these properties (`{ env: ["LOG_LEVEL"] }`), or the
   * whole property with `null`.
   */
  del(patch: DeletePatch<Props, Members>): this {
    this.#items.push(...toPatchItems<P>(patch as object, "del", this.#normalise));
    return this;
  }

  /** The wire triples staged so far. */
  get changes(): ReadonlyArray<PatchItem<P>> {
    return this.#items;
  }

  /** Send every staged change as one update. */
  apply(): R {
    if (this.#items.length === 0) {
      throw new TypeError(
        `This ${this.#what} edit has no changes to apply; call set(), add() or del() first.`,
      );
    }
    return this.#commit(this.#items);
  }
}
