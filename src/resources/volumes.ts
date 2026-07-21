// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

import type * as models from "../api/platform/models.gen.js";
import { VolumesApi } from "../api/platform/volumes.gen.js";
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

/** Reference(s) accepted by volume operations: `{ name }` or `{ uuid }`. */
export type VolumeRef = Ref;

/** Attachment spec for {@link VolumeHandle.attach} (target instance + mountpoint). */
export type VolumeAttach = Omit<models.AttachVolumesRequestItem, "uuid" | "name">;

/** Detachment spec for {@link VolumeHandle.detach}. */
export type VolumeDetach = Omit<models.DetachVolumesRequestItem, "uuid" | "name">;

/**
 * A raw mutation triple, as the API models an update. Accepted by
 * {@link Volumes.update} as an escape hatch; prefer the patch object.
 */
export type VolumePatch = Pick<models.UpdateVolumesRequestItem, "prop" | "op" | "value">;

/** A volume's mutable properties, and the type each one takes. */
export interface VolumeProperties {
  /** Size in MiB. */
  size_mb: number;
  /** Tags. */
  tags: string[];
  /** How the volume's quota is enforced. */
  quota_policy: models.VolumeQuotaPolicy;
  /** Whether deletion is blocked. */
  delete_lock: boolean;
}

/** The members `del` can remove from a volume's collection properties. */
export interface VolumeMembers {
  /** Tags. */
  tags: string[];
}

/**
 * Changes to apply to a volume: a value per property, or `null` to remove the
 * property.
 *
 * @example
 * await ukc.volumes.get({ name: "data" }).update({ size_mb: 2048 });
 */
export type VolumeUpdate = Patch<VolumeProperties>;

/** A volume as an update reports it back. */
export type UpdatedVolume = WithMetro<models.UpdateVolumesResponseUpdatedVolume>;

/** A staged multi-operation edit of one volume. */
export type VolumeEditor = ResourceEditor<
  models.MutableVolumeProperty,
  VolumeProperties,
  VolumeMembers,
  VolumeHandle<UpdatedVolume>
>;

/** Build the wire triples for an update, from either accepted form. */
function volumeChanges(
  changes: VolumeUpdate | VolumePatch[],
): Array<PatchItem<models.MutableVolumeProperty>> {
  return Array.isArray(changes)
    ? changes
    : toPatchItems<models.MutableVolumeProperty>(changes, "set");
}

/** Options for {@link Volumes.list}. */
export interface ListVolumesOptions extends ScopeOptions {
  details?: boolean;
  tags?: string[];
  pageSize?: number;
}

/** A volume, tagged with the metro it lives in. */
export type Volume = WithMetro<models.Volume>;

/**
 * A chainable reference to one volume in one metro.
 *
 * @example
 * await ukc.volumes.get({ name: "data" }).attach({ attach_to: { name: "web" }, at: "/data" });
 */
export class VolumeHandle<T> extends ResourceHandle<T> {
  readonly #volumes: Volumes;

  constructor(volumes: Volumes, steps: HandleSteps<T>) {
    super(steps);
    this.#volumes = volumes;
  }

  /** Re-read the volume's full details. */
  refresh(opts: CallOptions = {}): VolumeHandle<Volume> {
    return this.#then((target) => this.#volumes.fetch(target, opts));
  }

  /** Attach the volume to an instance. */
  attach(spec: VolumeAttach, opts: CallOptions = {}) {
    return this.#then((target) =>
      this.#one(
        target,
        this.#volumes.api.attachVolumes({
          body: [{ ...target.ref, ...spec }],
          ...call(target, opts),
        }),
      ),
    );
  }

  /** Detach the volume from the instance(s) it is attached to. */
  detach(spec: VolumeDetach = {}, opts: CallOptions = {}) {
    return this.#then((target) =>
      this.#one(
        target,
        this.#volumes.api.detachVolumes({
          body: [{ ...target.ref, ...spec }],
          ...call(target, opts),
        }),
      ),
    );
  }

  /**
   * Change the volume's properties and return the updated volume. Pass a value
   * to set it, or `null` to remove the property.
   *
   * @example
   * await ukc.volumes.get({ name: "data" }).update({ size_mb: 2048 });
   */
  update(changes: VolumeUpdate | VolumePatch[], opts: CallOptions = {}) {
    return this.#patch(volumeChanges(changes), opts);
  }

  /**
   * Stage several operations and send them as one update.
   *
   * @example
   * await ukc.volumes.get({ name: "data" }).edit()
   *   .set({ size_mb: 2048 })
   *   .add({ tags: ["prod"] })
   *   .apply();
   */
  edit(opts: CallOptions = {}): VolumeEditor {
    return new ResourceEditor((changes) => this.#patch(changes, opts), "volume");
  }

  /** Send update triples against the metro this handle resolved to. */
  #patch(changes: Array<PatchItem<models.MutableVolumeProperty>>, opts: CallOptions) {
    return this.#then((target) =>
      this.#one(
        target,
        this.#volumes.api.updateVolumes({
          body: changes.map((change) => ({ ...target.ref, ...change })),
          ...call(target, opts),
        }),
      ),
    );
  }

  /** Delete the volume. */
  delete(opts: CallOptions = {}) {
    return this.#then((target) =>
      this.#one(
        target,
        this.#volumes.api.deleteVolumes({ body: [target.ref], ...call(target, opts) }),
      ),
    );
  }

  #then<R>(fetch: (target: MetroTarget) => Promise<R>): VolumeHandle<R> {
    return new VolumeHandle(this.#volumes, {
      locate: async () => ({ target: await this.next() }),
      fetch,
      sequential: true,
    });
  }

  #one<R extends ListEnvelope<"volumes">>(target: MetroTarget, work: Promise<R>) {
    return firstTagged(work, "volumes", target.metro, `volume ${describeRef(target.ref)}`);
  }
}

/** Per-call options for a plumbing call pinned to one metro. */
function call(target: MetroTarget, opts: CallOptions): CallOptions {
  return { ...opts, baseUrl: target.baseUrl };
}

/**
 * Every volume matching one ref, one per metro. Operations run in all of them
 * concurrently and return one result per metro.
 *
 * @example
 * await ukc.volumes.each({ name: "data" }).update({ size_mb: 2048 });
 */
export class VolumeSet extends HandleSet<VolumeHandle<Volume>, Volume> {
  /** Re-read every match's full details. */
  refresh(opts: CallOptions = {}) {
    return this.map((handle) => handle.refresh(opts));
  }

  /** Attach every match to an instance. */
  attach(spec: VolumeAttach, opts: CallOptions = {}) {
    return this.map((handle) => handle.attach(spec, opts));
  }

  /** Detach every match. */
  detach(spec: VolumeDetach = {}, opts: CallOptions = {}) {
    return this.map((handle) => handle.detach(spec, opts));
  }

  /** Apply the same changes to every match. */
  update(changes: VolumeUpdate | VolumePatch[], opts: CallOptions = {}) {
    return this.map((handle) => handle.update(changes, opts));
  }

  /** Stage changes once and apply them to every match. */
  edit(
    opts: CallOptions = {},
  ): ResourceEditor<
    models.MutableVolumeProperty,
    VolumeProperties,
    VolumeMembers,
    Promise<UpdatedVolume[]>
  > {
    return new ResourceEditor(
      (changes) => this.map((handle) => handle.update(changes, opts)),
      "volume",
    );
  }

  /** Delete every match. */
  delete(opts: CallOptions = {}) {
    return this.map((handle) => handle.delete(opts));
  }
}

/** Idiomatic client for Unikraft Cloud volumes. */
export class Volumes extends Resource<VolumesApi> {
  protected readonly noun = "volume";

  constructor(session: Session, scope: MetroScope) {
    super(session, scope, new VolumesApi(session.platform));
  }

  /** Create a volume in a single metro and return a handle to it. */
  create(spec: models.CreateVolumeRequest, opts: ScopeOptions = {}): VolumeHandle<Volume> {
    return new VolumeHandle(this, {
      locate: async () => {
        const endpoint = await this.oneEndpoint("Creating a volume", opts);
        const volume = (await firstTagged(
          this.api.createVolume({ body: spec, ...this.call(endpoint, opts) }),
          "volumes",
          endpoint.metro,
          "volume",
        )) as Volume;
        const ref: Ref =
          volume.uuid !== undefined ? { uuid: volume.uuid } : ({ name: volume.name } as Ref);
        return { target: this.target(endpoint, ref), value: volume };
      },
      fetch: (target) => this.fetch(target, opts),
    });
  }

  /** Reference a single volume by `{ name }` or `{ uuid }`. */
  get(id: VolumeRef, opts: ScopeOptions = {}): VolumeHandle<Volume> {
    return new VolumeHandle(this, {
      locate: () => this.locate(id, opts, (endpoint) => this.#find(endpoint, id, opts)),
      fetch: (target) => this.fetch(target, opts),
    });
  }

  /**
   * Reference every volume matching a ref — one per metro that holds it.
   *
   * @example
   * await ukc.volumes.each({ name: "data" }).update({ size_mb: 2048 });
   */
  each(id: VolumeRef, opts: ScopeOptions = {}): VolumeSet {
    return new VolumeSet(async () => {
      const located = await this.locateAll(id, opts, (endpoint) => this.#find(endpoint, id, opts));
      return located.map(
        (hit) =>
          new VolumeHandle<Volume>(this, {
            locate: () => Promise.resolve(hit),
            fetch: (target) => this.fetch(target, opts),
          }),
      );
    });
  }

  /** Lazily iterate every volume in scope, following pagination per metro. */
  list(opts: ListVolumesOptions = {}): AsyncGenerator<Volume, void, void> {
    const { details, tags, pageSize, ...rest } = opts;
    const self = this;
    return (async function* () {
      const endpoints = await self.endpoints(opts);
      yield* fanout(endpoints, (endpoint) =>
        paginate({
          pageSize,
          cursor: (v) => v.uuid,
          fetchPage: async ({ count, from }) => {
            const res = await self.api.getVolumes({
              count,
              from,
              details,
              tags,
              ...self.call(endpoint, rest),
            });
            return unwrapList(res, "volumes").map((v) => withMetro(v, endpoint.metro));
          },
        }),
      );
    })();
  }

  /** Delete one or more volumes, in whichever metros hold them. */
  delete(ids: VolumeRef | ReadonlyArray<VolumeRef>, opts: ScopeOptions = {}) {
    return this.#bulk(ids, opts, (group) =>
      this.api.deleteVolumes({ body: group.refs, ...this.call(group.endpoint, opts) }),
    );
  }

  /** Attach a single volume to an instance. Shorthand for `get(id).attach(...)`. */
  attach(id: VolumeRef, spec: VolumeAttach, opts: ScopeOptions = {}) {
    return this.get(id, opts).attach(spec);
  }

  /** Detach a single volume. Shorthand for `get(id).detach(...)`. */
  detach(id: VolumeRef, spec: VolumeDetach = {}, opts: ScopeOptions = {}) {
    return this.get(id, opts).detach(spec);
  }

  /** Change a single volume's properties. Shorthand for `get(id).update(...)`. */
  update(id: VolumeRef, changes: VolumeUpdate | VolumePatch[], opts: ScopeOptions = {}) {
    return this.get(id, opts).update(changes);
  }

  /** Stage several operations against a single volume. Shorthand for `get(id).edit()`. */
  edit(id: VolumeRef, opts: ScopeOptions = {}): VolumeEditor {
    return this.get(id, opts).edit();
  }

  /**
   * Read one volume's full details from the metro it was located in.
   *
   * @internal Used by {@link VolumeHandle}.
   */
  fetch(target: MetroTarget, opts: ScopeOptions = {}): Promise<Volume> {
    return firstTagged(
      this.api.getVolumes({
        ...toQuery(target.ref),
        details: true,
        ...this.call(target, opts),
      }),
      "volumes",
      target.metro,
      `volume ${describeRef(target.ref)}`,
    ) as Promise<Volume>;
  }

  /** Look for one volume in one metro; absent is not a failure. */
  #find(
    endpoint: MetroEndpoint,
    id: VolumeRef,
    opts: ScopeOptions,
  ): Promise<models.Volume | undefined> {
    return orAbsent(
      this.api
        .getVolumes({ ...toQuery(id), details: true, ...this.call(endpoint, opts) })
        .then((res) => unwrapList(res, "volumes")[0]),
    );
  }

  async #bulk<R extends ListEnvelope<"volumes">>(
    ids: VolumeRef | ReadonlyArray<VolumeRef>,
    opts: ScopeOptions,
    each: (group: MetroGroup) => Promise<R>,
  ): Promise<Array<WithMetro<EntryOf<R, "volumes">>>> {
    const groups = await this.groupByMetro(ids, opts, (endpoint, ref) =>
      this.#find(endpoint, ref, opts),
    );
    return this.runGroups(groups, (group) =>
      listTagged(each(group), "volumes", group.endpoint.metro),
    );
  }
}
