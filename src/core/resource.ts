// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// The base every idiomatic ("porcelain") resource client is built on. It owns
// the metro scope, the generated plumbing client the operations are issued
// through, and the two hard problems of a metro-scoped API: finding which metro
// holds a named resource, and grouping a bulk operation by metro.

import { AmbiguousRefError, type MetroFailure, MetroFanoutError, fanoutSettled } from "./fanout.js";
import type { Located, MetroTarget } from "./handle.js";
import type { ApiClient, CallOptions } from "./http.js";
import { UnikraftCloudError } from "./http.js";
import {
  type Metro,
  type MetroEndpoint,
  type MetroScope,
  type WithMetro,
  metroEndpoint,
  withMetro,
} from "./metro.js";
import {
  type Envelope,
  type Ref,
  describeRef,
  toRefs,
  unwrapFirst,
  unwrapList,
  wireRef,
} from "./response.js";
import type { Session } from "./session.js";

// `WithMetro`/`withMetro` live alongside the metro types so the lower-level
// modules can use them; re-exported here, where resource code reaches for them.
export { type WithMetro, withMetro } from "./metro.js";

/** Any response envelope whose payload carries a list under `key`. */
export type ListEnvelope<K extends string> = {
  status: string;
} & { data?: Partial<Record<K, unknown[]>> };

/** The element type of a response envelope's `data[key]` list. */
export type EntryOf<R, K extends string> = R extends {
  data?: Partial<Record<K, Array<infer E>>>;
}
  ? E
  : never;

/**
 * Unwrap the single resource a per-resource operation reports and tag it with
 * the metro that served it.
 */
export async function firstTagged<K extends string, R extends ListEnvelope<K>>(
  work: Promise<R>,
  key: K,
  metro: Metro,
  what: string,
): Promise<WithMetro<EntryOf<R, K>>> {
  const res = (await work) as Envelope<Record<K, unknown[]>>;
  const entry = unwrapFirst(res, key, what);
  return withMetro(entry as object, metro) as WithMetro<EntryOf<R, K>>;
}

/** Unwrap a list response and tag every entry with the metro that served it. */
export async function listTagged<K extends string, R extends ListEnvelope<K>>(
  work: Promise<R>,
  key: K,
  metro: Metro,
): Promise<Array<WithMetro<EntryOf<R, K>>>> {
  const res = (await work) as Envelope<Record<K, unknown[]>>;
  return unwrapList(res, key).map(
    (entry) => withMetro(entry as object, metro) as WithMetro<EntryOf<R, K>>,
  );
}

/** Call options plus a per-call override of which metros to cover. */
export interface ScopeOptions extends CallOptions {
  /**
   * Metros this call covers, overriding the client's scope: `"all"`, one metro,
   * or a list. Naming metros also skips metro discovery.
   */
  metros?: MetroScope;
}

/** A bulk operation's refs, grouped by the metro that holds them. */
export interface MetroGroup {
  endpoint: MetroEndpoint;
  refs: Ref[];
}

/**
 * Base class for the idiomatic resource clients. Each holds — rather than
 * extends — its generated plumbing client, keeping the two layers distinct:
 * short verbs here, raw spec operations on {@link Resource.api}.
 */
export abstract class Resource<A extends ApiClient> {
  /**
   * The raw ("plumbing") client for this resource: every operation in the
   * OpenAPI specification, returning the response envelope untouched. Calls go
   * to the client's default metro unless given a `baseUrl`.
   *
   * @example
   * const res = await ukc.instances.api.getInstances({ count: 10 });
   * res.data?.instances;
   */
  readonly api: A;

  protected readonly session: Session;
  protected readonly scope: MetroScope;
  /** Human-readable noun used in error messages, e.g. `"instance"`. */
  protected abstract readonly noun: string;

  protected constructor(session: Session, scope: MetroScope, api: A) {
    this.session = session;
    this.scope = scope;
    this.api = api;
  }

  /** The endpoints a call covers, honouring a per-call scope or `baseUrl`. */
  protected endpoints(opts: ScopeOptions = {}): Promise<MetroEndpoint[]> {
    // An explicit per-call baseUrl names exactly one endpoint, whatever the
    // scope says; it is how callers already redirect a single call.
    if (opts.baseUrl !== undefined) {
      return Promise.resolve([{ metro: opts.baseUrl, baseUrl: opts.baseUrl }]);
    }
    return this.session.resolve(opts.metros ?? this.scope);
  }

  /** The single endpoint an operation that must pick one metro should use. */
  protected async oneEndpoint(operation: string, opts: ScopeOptions = {}): Promise<MetroEndpoint> {
    if (opts.baseUrl !== undefined) return { metro: opts.baseUrl, baseUrl: opts.baseUrl };
    return this.session.resolveOne(opts.metros ?? this.scope, operation);
  }

  /**
   * The endpoints to search for one ref. A ref that names its own metro
   * (`{ name: "web", metro: "fra" }`) needs no search and no discovery.
   */
  protected async endpointsFor(ref: Ref, opts: ScopeOptions = {}): Promise<MetroEndpoint[]> {
    if (ref.metro !== undefined && opts.baseUrl === undefined) {
      // An explicitly configured endpoint still wins: there is only one to talk to.
      return [this.session.pinned ?? metroEndpoint(ref.metro)];
    }
    return this.endpoints(opts);
  }

  /**
   * Find which metro holds a single resource.
   *
   * Nothing is sent when the answer is already known — a ref carrying `metro`,
   * or a scope of exactly one — which is what keeps `get(ref).suspend()` down to
   * one request. Otherwise every metro in scope is asked concurrently, and the
   * resource that was found travels back with the target so it need not be read
   * again.
   *
   * A name can exist in several metros at once. When it does, this throws an
   * {@link AmbiguousRefError} carrying every match rather than picking one,
   * because the caller may be about to mutate it.
   */
  protected async locate<T extends object>(
    ref: Ref,
    opts: ScopeOptions,
    find: (endpoint: MetroEndpoint) => Promise<T | undefined>,
  ): Promise<Located<WithMetro<T>>> {
    const endpoints = await this.endpointsFor(ref, opts);
    if (endpoints.length === 1) {
      const endpoint = endpoints[0] as MetroEndpoint;
      return { target: { ...endpoint, ref: wireRef(ref) } };
    }

    const found = await this.#search(ref, endpoints, find);
    if (found.length > 1) {
      const metros = found.map((hit) => hit.endpoint.metro);
      throw new AmbiguousRefError(
        `${this.noun} ${describeRef(ref)} exists in ${found.length} metros (${metros.join(
          ", ",
        )}). Say which one with \`{ ${ref.uuid !== undefined ? "uuid" : "name"}: ${JSON.stringify(
          ref.uuid ?? ref.name,
        )}, metro: ${JSON.stringify(metros[0])} }\`, or act on all of them with \`each()\`.`,
        found.map((hit) => withMetro(hit.value, hit.endpoint.metro)),
      );
    }

    const hit = found[0] as { endpoint: MetroEndpoint; value: T };
    return {
      target: { ...hit.endpoint, ref: wireRef(ref) },
      value: withMetro(hit.value, hit.endpoint.metro),
    };
  }

  /**
   * Locate *every* metro holding a resource that matches the ref — the same name
   * in five metros is five results, not an error.
   */
  protected async locateAll<T extends object>(
    ref: Ref,
    opts: ScopeOptions,
    find: (endpoint: MetroEndpoint) => Promise<T | undefined>,
  ): Promise<Array<Located<WithMetro<T>>>> {
    const endpoints = await this.endpointsFor(ref, opts);
    if (endpoints.length === 1) {
      // One endpoint: the ref is already unambiguous, so read it lazily like
      // `locate()` does rather than spending a request to confirm it exists.
      const endpoint = endpoints[0] as MetroEndpoint;
      return [{ target: { ...endpoint, ref: wireRef(ref) } }];
    }

    const found = await this.#search(ref, endpoints, find);
    return found.map((hit) => ({
      target: { ...hit.endpoint, ref: wireRef(ref) },
      value: withMetro(hit.value, hit.endpoint.metro),
    }));
  }

  /**
   * Ask every endpoint for the ref concurrently and return the matches. Absent
   * is not a failure — most metros legitimately do not hold it — but finding
   * nothing anywhere is, as is finding nothing while some metro was unreachable.
   */
  async #search<T extends object>(
    ref: Ref,
    endpoints: readonly MetroEndpoint[],
    find: (endpoint: MetroEndpoint) => Promise<T | undefined>,
  ): Promise<Array<{ endpoint: MetroEndpoint; value: T }>> {
    const outcomes = await fanoutSettled(endpoints, find);
    const failures: MetroFailure[] = [];
    const found: Array<{ endpoint: MetroEndpoint; value: T }> = [];
    for (const outcome of outcomes) {
      if (!outcome.ok) failures.push({ metro: outcome.endpoint.metro, error: outcome.error });
      else if (outcome.value !== undefined) {
        found.push({ endpoint: outcome.endpoint, value: outcome.value });
      }
    }

    if (found.length === 0) {
      const searched = endpoints.map((e) => e.metro).join(", ");
      // A metro that failed might have been the one holding it, so say so
      // rather than reporting a bare 404 the caller cannot act on.
      if (failures.length > 0) {
        throw new MetroFanoutError(
          `${this.noun} ${describeRef(ref)} was not found in ${searched}, and ${
            failures.length
          } of those metros could not be reached: ${failures.map((f) => f.metro).join(", ")}.`,
          failures,
        );
      }
      throw new UnikraftCloudError(`${this.noun} ${describeRef(ref)} not found in ${searched}`, {
        kind: "http",
        status: 404,
      });
    }
    return found;
  }

  /**
   * Group refs by the metro that holds them, so a bulk operation becomes one call
   * per metro. Free when the scope is a single metro or every ref names its own;
   * otherwise the refs are located first.
   *
   * A ref matching in several metros contributes to each of them: a bulk
   * operation says what it means, and the scope is what bounds it. Narrow the
   * scope (`ukc.metro("fra")`) or qualify the ref (`{ name, metro }`) to act on
   * one.
   */
  protected async groupByMetro<T extends object>(
    ids: Ref | ReadonlyArray<Ref>,
    opts: ScopeOptions,
    find: (endpoint: MetroEndpoint, ref: Ref) => Promise<T | undefined>,
  ): Promise<MetroGroup[]> {
    const refs = toRefs(ids);
    const endpoints = await this.endpoints(opts);
    if (endpoints.length === 1 && refs.every((ref) => ref.metro === undefined)) {
      return [{ endpoint: endpoints[0] as MetroEndpoint, refs: refs.map(wireRef) }];
    }

    const located = await Promise.all(
      refs.map((ref) => this.locateAll(ref, opts, (endpoint) => find(endpoint, ref))),
    );

    const groups = new Map<string, MetroGroup>();
    for (const { target } of located.flat()) {
      const group = groups.get(target.baseUrl);
      if (group) group.refs.push(target.ref);
      else {
        groups.set(target.baseUrl, {
          endpoint: { metro: target.metro, baseUrl: target.baseUrl },
          refs: [target.ref],
        });
      }
    }
    return [...groups.values()];
  }

  /**
   * Run one bulk call per metro group concurrently and concatenate the results.
   * Metros that answered are reported even when others failed; the aggregate
   * {@link MetroFanoutError} is thrown after the successful results are in hand
   * (on it, as `err.results`).
   */
  protected async runGroups<T>(
    groups: readonly MetroGroup[],
    each: (group: MetroGroup) => Promise<T[]>,
  ): Promise<T[]> {
    if (groups.length === 1) return each(groups[0] as MetroGroup);

    const outcomes = await fanoutSettled(
      groups.map((g) => g.endpoint),
      (endpoint) => each(groups.find((g) => g.endpoint.baseUrl === endpoint.baseUrl) as MetroGroup),
    );

    const results: T[] = [];
    const failures: MetroFailure[] = [];
    for (const outcome of outcomes) {
      if (outcome.ok) results.push(...outcome.value);
      else failures.push({ metro: outcome.endpoint.metro, error: outcome.error });
    }
    if (failures.length > 0) {
      const error = new MetroFanoutError(
        `${failures.length} of ${groups.length} metros failed: ${failures
          .map((f) => f.metro)
          .join(", ")}.`,
        failures,
      );
      // The partial results are the useful half of a partial failure; a bulk
      // call cannot yield them like an iteration can, so carry them along.
      (error as MetroFanoutError & { results?: T[] }).results = results;
      throw error;
    }
    return results;
  }

  /** Build the per-call params every plumbing operation accepts. */
  protected call(endpoint: MetroEndpoint, opts: ScopeOptions = {}): CallOptions {
    const { metros: _metros, baseUrl: _baseUrl, ...call } = opts;
    return { ...call, baseUrl: endpoint.baseUrl };
  }

  /** The target of a single-resource operation, for building handles. */
  protected target(endpoint: MetroEndpoint, ref: Ref): MetroTarget {
    return { ...endpoint, ref };
  }
}
