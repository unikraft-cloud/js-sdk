// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

import type * as models from "../api/platform/models.gen.js";
import { ServiceGroupsApi } from "../api/platform/service-groups.gen.js";
import { fanout } from "../core/fanout.js";
import { HandleSet } from "../core/handle-set.js";
import { type HandleSteps, type MetroTarget, ResourceHandle } from "../core/handle.js";
import type { CallOptions } from "../core/http.js";
import type { MetroEndpoint, MetroScope } from "../core/metro.js";
import { paginate } from "../core/pagination.js";
import { type Patch, type PatchItem, ResourceEditor, toPatchItems } from "../core/patch.js";
import {
  type EntryOf,
  type ListEnvelope,
  type MetroGroup,
  Resource,
  type ScopeOptions,
  type WithMetro,
  firstTagged,
  listTagged,
  withMetro,
} from "../core/resource.js";
import { type Ref, describeRef, orAbsent, toQuery, unwrapList } from "../core/response.js";
import type { Session } from "../core/session.js";

/** Reference(s) accepted by service-group operations: `{ name }` or `{ uuid }`. */
export type ServiceGroupRef = Ref;

/**
 * A raw mutation triple, as the API models an update. Accepted by
 * {@link ServiceGroups.update} as an escape hatch; prefer the patch object.
 */
export type ServiceGroupPatch = Pick<
  models.UpdateServiceGroupsRequestItem,
  "prop" | "op" | "value"
>;

/** A service group's mutable properties, and the type each one takes. */
export interface ServiceGroupProperties {
  /** Published services. */
  services: models.Service[];
  /** Domains served by the group. */
  domains: models.CreateServiceGroupRequestDomain[];
  /** Soft instance limit (1–65535, at most `hard_limit`). */
  soft_limit: number;
  /** Hard instance limit (1–65535, at least `soft_limit`). */
  hard_limit: number;
  /** Idle autokill. */
  autokill: models.CreateServiceGroupRequestAutokill;
}

/** The members `del` can remove from a service group's collection properties. */
export interface ServiceGroupMembers {
  /** Services. */
  services: models.Service[];
  /** Domains. */
  domains: models.CreateServiceGroupRequestDomain[];
}

/**
 * Changes to apply to a service group: a value per property, or `null` to remove
 * the property.
 *
 * @example
 * await ukc.services.get({ name: "web" }).update({ hard_limit: 20 });
 */
export type ServiceGroupUpdate = Patch<ServiceGroupProperties>;

/** A service group as an update reports it back. */
export type UpdatedServiceGroup = WithMetro<models.UpdateServiceGroupsResponseUpdatedServiceGroup>;

/** A staged multi-operation edit of one service group. */
export type ServiceGroupEditor = ResourceEditor<
  models.MutableServiceGroupProperty,
  ServiceGroupProperties,
  ServiceGroupMembers,
  ServiceGroupHandle<UpdatedServiceGroup>
>;

/** Build the wire triples for an update, from either accepted form. */
function serviceGroupChanges(
  changes: ServiceGroupUpdate | ServiceGroupPatch[],
): Array<PatchItem<models.MutableServiceGroupProperty>> {
  return Array.isArray(changes)
    ? changes
    : toPatchItems<models.MutableServiceGroupProperty>(changes, "set");
}

/** Options for {@link ServiceGroups.list}. */
export interface ListServiceGroupsOptions extends ScopeOptions {
  details?: boolean;
  pageSize?: number;
}

/** A service group, tagged with the metro it lives in. */
export type ServiceGroup = WithMetro<models.ServiceGroup>;

/** A chainable reference to one service group in one metro. */
export class ServiceGroupHandle<T> extends ResourceHandle<T> {
  readonly #services: ServiceGroups;

  constructor(services: ServiceGroups, steps: HandleSteps<T>) {
    super(steps);
    this.#services = services;
  }

  /** Re-read the service group's full details. */
  refresh(opts: CallOptions = {}): ServiceGroupHandle<ServiceGroup> {
    return this.#then((target) => this.#services.fetch(target, opts));
  }

  /**
   * Change the service group's properties and return the updated group. Pass a
   * value to set it, or `null` to remove the property.
   *
   * @example
   * await ukc.services.get({ name: "web" }).update({ soft_limit: 5, hard_limit: 20 });
   */
  update(changes: ServiceGroupUpdate | ServiceGroupPatch[], opts: CallOptions = {}) {
    return this.#patch(serviceGroupChanges(changes), opts);
  }

  /**
   * Stage several operations and send them as one update.
   *
   * @example
   * await ukc.services.get({ name: "web" }).edit()
   *   .set({ hard_limit: 20 })
   *   .add({ domains: [{ name: "api.example.com" }] })
   *   .apply();
   */
  edit(opts: CallOptions = {}): ServiceGroupEditor {
    return new ResourceEditor((changes) => this.#patch(changes, opts), "service group");
  }

  /** Send update triples against the metro this handle resolved to. */
  #patch(changes: Array<PatchItem<models.MutableServiceGroupProperty>>, opts: CallOptions) {
    return this.#then((target) =>
      this.#one(
        target,
        this.#services.api.updateServiceGroups({
          body: changes.map((change) => ({ ...target.ref, ...change })),
          ...call(target, opts),
        }),
      ),
    );
  }

  /** Delete the service group. */
  delete(opts: CallOptions = {}) {
    return this.#then((target) =>
      this.#one(
        target,
        this.#services.api.deleteServiceGroups({ body: [target.ref], ...call(target, opts) }),
      ),
    );
  }

  #then<R>(fetch: (target: MetroTarget) => Promise<R>): ServiceGroupHandle<R> {
    return new ServiceGroupHandle(this.#services, {
      locate: async () => ({ target: await this.next() }),
      fetch,
      sequential: true,
    });
  }

  #one<R extends ListEnvelope<"service_groups">>(target: MetroTarget, work: Promise<R>) {
    return firstTagged(
      work,
      "service_groups",
      target.metro,
      `service group ${describeRef(target.ref)}`,
    );
  }
}

/** Per-call options for a plumbing call pinned to one metro. */
function call(target: MetroTarget, opts: CallOptions): CallOptions {
  return { ...opts, baseUrl: target.baseUrl };
}

/**
 * Every service group matching one ref, one per metro.
 *
 * @example
 * await ukc.services.each({ name: "web" }).update({ hard_limit: 20 });
 */
export class ServiceGroupSet extends HandleSet<ServiceGroupHandle<ServiceGroup>, ServiceGroup> {
  /** Re-read every match's full details. */
  refresh(opts: CallOptions = {}) {
    return this.map((handle) => handle.refresh(opts));
  }

  /** Apply the same changes to every match. */
  update(changes: ServiceGroupUpdate | ServiceGroupPatch[], opts: CallOptions = {}) {
    return this.map((handle) => handle.update(changes, opts));
  }

  /** Stage changes once and apply them to every match. */
  edit(
    opts: CallOptions = {},
  ): ResourceEditor<
    models.MutableServiceGroupProperty,
    ServiceGroupProperties,
    ServiceGroupMembers,
    Promise<UpdatedServiceGroup[]>
  > {
    return new ResourceEditor(
      (changes) => this.map((handle) => handle.update(changes, opts)),
      "service group",
    );
  }

  /** Delete every match. */
  delete(opts: CallOptions = {}) {
    return this.map((handle) => handle.delete(opts));
  }
}

/** Idiomatic client for Unikraft Cloud service groups. */
export class ServiceGroups extends Resource<ServiceGroupsApi> {
  protected readonly noun = "service group";

  constructor(session: Session, scope: MetroScope) {
    super(session, scope, new ServiceGroupsApi(session.platform));
  }

  /** Create a service group in a single metro and return a handle to it. */
  create(
    spec: models.CreateServiceGroupRequest,
    opts: ScopeOptions = {},
  ): ServiceGroupHandle<ServiceGroup> {
    return new ServiceGroupHandle(this, {
      locate: async () => {
        const endpoint = await this.oneEndpoint("Creating a service group", opts);
        const group = (await firstTagged(
          this.api.createServiceGroup({ body: spec, ...this.call(endpoint, opts) }),
          "service_groups",
          endpoint.metro,
          "service group",
        )) as ServiceGroup;
        const ref: Ref =
          group.uuid !== undefined ? { uuid: group.uuid } : ({ name: group.name } as Ref);
        return { target: this.target(endpoint, ref), value: group };
      },
      fetch: (target) => this.fetch(target, opts),
    });
  }

  /** Reference a single service group by `{ name }` or `{ uuid }`. */
  get(id: ServiceGroupRef, opts: ScopeOptions = {}): ServiceGroupHandle<ServiceGroup> {
    return new ServiceGroupHandle(this, {
      locate: () => this.locate(id, opts, (endpoint) => this.#find(endpoint, id, opts)),
      fetch: (target) => this.fetch(target, opts),
    });
  }

  /**
   * Reference every service group matching a ref — one per metro that holds it.
   *
   * @example
   * await ukc.services.each({ name: "web" }).update({ hard_limit: 20 });
   */
  each(id: ServiceGroupRef, opts: ScopeOptions = {}): ServiceGroupSet {
    return new ServiceGroupSet(async () => {
      const located = await this.locateAll(id, opts, (endpoint) => this.#find(endpoint, id, opts));
      return located.map(
        (hit) =>
          new ServiceGroupHandle<ServiceGroup>(this, {
            locate: () => Promise.resolve(hit),
            fetch: (target) => this.fetch(target, opts),
          }),
      );
    });
  }

  /** Lazily iterate every service group in scope, following pagination per metro. */
  list(opts: ListServiceGroupsOptions = {}): AsyncGenerator<ServiceGroup, void, void> {
    const { details, pageSize, ...rest } = opts;
    const self = this;
    return (async function* () {
      const endpoints = await self.endpoints(opts);
      yield* fanout(endpoints, (endpoint) =>
        paginate({
          pageSize,
          cursor: (s) => s.uuid,
          fetchPage: async ({ count, from }) => {
            const res = await self.api.getServiceGroups({
              count,
              from,
              details,
              ...self.call(endpoint, rest),
            });
            return unwrapList(res, "service_groups").map((s) => withMetro(s, endpoint.metro));
          },
        }),
      );
    })();
  }

  /** Delete one or more service groups, in whichever metros hold them. */
  delete(ids: ServiceGroupRef | ReadonlyArray<ServiceGroupRef>, opts: ScopeOptions = {}) {
    return this.#bulk(ids, opts, (group) =>
      this.api.deleteServiceGroups({ body: group.refs, ...this.call(group.endpoint, opts) }),
    );
  }

  /** Change a single service group's properties. Shorthand for `get(id).update(...)`. */
  update(
    id: ServiceGroupRef,
    changes: ServiceGroupUpdate | ServiceGroupPatch[],
    opts: ScopeOptions = {},
  ) {
    return this.get(id, opts).update(changes);
  }

  /** Stage several operations against a single service group. Shorthand for `get(id).edit()`. */
  edit(id: ServiceGroupRef, opts: ScopeOptions = {}): ServiceGroupEditor {
    return this.get(id, opts).edit();
  }

  /**
   * Read one service group's full details from the metro it was located in.
   *
   * @internal Used by {@link ServiceGroupHandle}.
   */
  fetch(target: MetroTarget, opts: ScopeOptions = {}): Promise<ServiceGroup> {
    return firstTagged(
      this.api.getServiceGroups({
        ...toQuery(target.ref),
        details: true,
        ...this.call(target, opts),
      }),
      "service_groups",
      target.metro,
      `service group ${describeRef(target.ref)}`,
    ) as Promise<ServiceGroup>;
  }

  /** Look for one service group in one metro; absent is not a failure. */
  #find(
    endpoint: MetroEndpoint,
    id: ServiceGroupRef,
    opts: ScopeOptions,
  ): Promise<models.ServiceGroup | undefined> {
    return orAbsent(
      this.api
        .getServiceGroups({ ...toQuery(id), details: true, ...this.call(endpoint, opts) })
        .then((res) => unwrapList(res, "service_groups")[0]),
    );
  }

  async #bulk<R extends ListEnvelope<"service_groups">>(
    ids: ServiceGroupRef | ReadonlyArray<ServiceGroupRef>,
    opts: ScopeOptions,
    each: (group: MetroGroup) => Promise<R>,
  ): Promise<Array<WithMetro<EntryOf<R, "service_groups">>>> {
    const groups = await this.groupByMetro(ids, opts, (endpoint, ref) =>
      this.#find(endpoint, ref, opts),
    );
    return this.runGroups(groups, (group) =>
      listTagged(each(group), "service_groups", group.endpoint.metro),
    );
  }
}
