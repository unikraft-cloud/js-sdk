// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

import { InstancesApi } from "../api/platform/instances.gen.js";
import type * as models from "../api/platform/models.gen.js";
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
import {
  type Ref,
  describeRef,
  orAbsent,
  toQuery,
  unwrapFirst,
  unwrapList,
} from "../core/response.js";
import type { Session } from "../core/session.js";

/** Reference(s) accepted by instance operations: `{ name }` or `{ uuid }`. */
export type InstanceRef = Ref;

/**
 * A raw mutation triple, as the API models an update. Accepted by
 * {@link Instances.update} as an escape hatch; prefer the patch object.
 */
export type InstancePatch = Pick<models.UpdateInstancesRequestItem, "prop" | "op" | "value">;

/**
 * An instance's mutable properties, and the type each one takes. This is the
 * typed counterpart of the API's `prop`/`value` pair, whose `value` is `unknown`.
 */
export interface InstanceProperties {
  /** Image to run: a reference string (`"nginx:latest"`) or a structured spec. */
  image: string | models.ImageSpec;
  /** Command-line arguments. */
  args: string | string[];
  /** Environment variables. */
  env: Record<string, string>;
  /** Memory in MiB. */
  memory_mb: number;
  /** Virtual CPUs. */
  vcpus: number;
  /** Scale-to-zero behaviour. */
  scale_to_zero: models.CreateInstanceScaleToZero;
  /** Tags. */
  tags: string[];
  /** Whether deletion is blocked. */
  delete_lock: boolean;
  /** Scheduled actions. */
  schedules: models.Schedule[];
  /** Idle/request-count autokill. */
  autokill: models.InstanceAutokill;
  /** Internal hostname (a valid DNS label). */
  hostname: string;
  /** Attached ROMs. */
  roms: models.CreateInstanceRequestRom[];
  /** Instances this one depends on, by name or UUID. */
  dependencies: Array<string | models.NameOrUUID>;
  /** Scheduling priority. */
  sched_priority: models.SchedPriority;
  /** Plugins. */
  plugins: models.CreateInstanceRequestPlugin[];
}

/**
 * The members `del` can remove from an instance's collection properties. Every
 * other property (and these too) accepts `null` to remove it wholesale.
 */
export interface InstanceMembers {
  /** Environment variable names. */
  env: string | string[];
  /** Tags. */
  tags: string[];
  /** Schedule names. */
  schedules: string[];
  /** ROM names. */
  roms: string[];
  /** Plugin names. */
  plugins: string[];
  /** Dependencies, by name or UUID. */
  dependencies: Array<string | models.NameOrUUID>;
}

/**
 * Changes to apply to an instance: a value per property, or `null` to remove the
 * property. Omitted properties are left alone.
 *
 * @example
 * await ukc.instances.get({ name: "web" }).update({ memory_mb: 512, vcpus: 2 });
 */
export type InstanceUpdate = Patch<InstanceProperties>;

/** An instance as an update reports it back. */
export type UpdatedInstance = WithMetro<models.UpdateInstancesResponseUpdatedInstance>;

/** A staged multi-operation edit of one instance. */
export type InstanceEditor = ResourceEditor<
  models.MutableInstanceProperty,
  InstanceProperties,
  InstanceMembers,
  InstanceHandle<UpdatedInstance>
>;

/** Build the wire triples for an update, from either accepted form. */
function instanceChanges(
  changes: InstanceUpdate | InstancePatch[],
): Array<PatchItem<models.MutableInstanceProperty>> {
  return Array.isArray(changes)
    ? changes
    : toPatchItems<models.MutableInstanceProperty>(changes, "set");
}

/**
 * Input for {@link Instances.create}. The specification already accepts `image`
 * as either a plain reference string (`"nginx:latest"`) or a structured
 * {@link models.ImageSpec}, so this is the generated request type as-is.
 */
export type CreateInstanceInput = models.CreateInstanceRequest;

/** Options for {@link Instances.list}. */
export interface ListInstancesOptions extends ScopeOptions {
  /** Return full instance details rather than just references. */
  details?: boolean;
  /** Filter by tags. */
  tags?: string[];
  /** Page size used while auto-paginating (default 100). */
  pageSize?: number;
}

/** Options for {@link InstanceHandle.logs}. */
export interface LogsOptions extends CallOptions {
  /**
   * Byte offset of the log output to receive. A negative value is relative to
   * the end of the log (e.g. `-4096` for the last 4 KiB).
   */
  offset?: number;
  /** Maximum number of bytes to return. */
  limit?: number;
}

/** Options for {@link InstanceHandle.wait}. */
export interface WaitOptions extends CallOptions {
  /** The state to wait for (default `"running"`). */
  state?: models.InstanceState;
  /** Timeout in seconds; `-1` waits indefinitely. */
  timeoutSeconds?: number;
}

/** An instance, tagged with the metro it lives in. */
export type Instance = WithMetro<models.Instance>;

/**
 * A chainable reference to one instance in one metro. Awaiting it yields the
 * instance; calling an operation on it returns another handle, so operations
 * compose without repeating the ref.
 *
 * Nothing is sent until the handle is awaited or an operation is chained onto
 * it. With a single metro in scope, `get(ref).suspend()` therefore performs one
 * request (the suspend); when the scope spans metros, the instance is located
 * first so the operation reaches the metro that actually holds it.
 *
 * @example
 * await ukc.instances.get({ name: "web" }).suspend();
 * await ukc.instances.create({ image: "nginx:latest" }).wait({ state: "running" }).logs();
 */
export class InstanceHandle<T> extends ResourceHandle<T> {
  readonly #instances: Instances;

  constructor(instances: Instances, steps: HandleSteps<T>) {
    super(steps);
    this.#instances = instances;
  }

  /** Re-read the instance's full details. */
  refresh(opts: CallOptions = {}): InstanceHandle<Instance> {
    return this.#then((target) => this.#instances.fetch(target, opts));
  }

  /** Start the instance. */
  start(opts: CallOptions = {}) {
    return this.#then((target) =>
      this.#one(
        target,
        this.#instances.api.startInstances({ body: [target.ref], ...call(target, opts) }),
      ),
    );
  }

  /** Stop the instance. */
  stop(opts: CallOptions = {}) {
    return this.#then((target) =>
      this.#one(
        target,
        this.#instances.api.stopInstances({ body: [target.ref], ...call(target, opts) }),
      ),
    );
  }

  /** Suspend the instance. */
  suspend(opts: CallOptions = {}) {
    return this.#then((target) =>
      this.#one(
        target,
        this.#instances.api.suspendInstances({ body: [target.ref], ...call(target, opts) }),
      ),
    );
  }

  /** Delete the instance. */
  delete(opts: CallOptions = {}) {
    return this.#then((target) =>
      this.#one(
        target,
        this.#instances.api.deleteInstances({ body: [target.ref], ...call(target, opts) }),
      ),
    );
  }

  /**
   * Change the instance's properties and return the updated instance. Pass a
   * value to set it, or `null` to remove the property; omitted properties are
   * left alone. The raw `{ prop, op, value }` triples are accepted too.
   *
   * @example
   * await ukc.instances.get({ name: "web" }).update({ memory_mb: 512, vcpus: 2 });
   * await ukc.instances.get({ name: "web" }).update({ env: { LOG_LEVEL: "debug" } });
   * await ukc.instances.get({ name: "web" }).update({ autokill: null });
   */
  update(changes: InstanceUpdate | InstancePatch[], opts: CallOptions = {}) {
    return this.#patch(instanceChanges(changes), opts);
  }

  /**
   * Stage several operations and send them as one update. Use this when `set` is
   * not enough — merging into a property, or removing individual members.
   *
   * @example
   * await ukc.instances.get({ name: "web" }).edit()
   *   .set({ memory_mb: 512 })
   *   .add({ env: { LOG_LEVEL: "debug" }, tags: ["prod"] })
   *   .del({ env: ["OLD_FLAG"] })
   *   .apply();
   */
  edit(opts: CallOptions = {}): InstanceEditor {
    return new ResourceEditor((changes) => this.#patch(changes, opts), "instance");
  }

  /** Send update triples against the metro this handle resolved to. */
  #patch(changes: Array<PatchItem<models.MutableInstanceProperty>>, opts: CallOptions) {
    return this.#then((target) =>
      this.#one(
        target,
        this.#instances.api.updateInstances({
          body: changes.map((change) => ({ ...target.ref, ...change })),
          ...call(target, opts),
        }),
      ),
    );
  }

  /**
   * Block until the instance reaches a state, and return what the API observed
   * (including the instance's final `state`). The API fails the request if the
   * timeout elapses first, so this rejects rather than returning.
   */
  wait(opts: WaitOptions = {}) {
    const { state, timeoutSeconds, ...rest } = opts;
    return this.#then((target) =>
      this.#one(
        target,
        this.#instances.api.waitInstances({
          ...toQuery(target.ref),
          ...(state === undefined ? {} : { state: [state] }),
          ...(timeoutSeconds === undefined ? {} : { timeout_s: [timeoutSeconds] }),
          ...call(target, rest),
        }),
      ),
    );
  }

  /**
   * Fetch the console log. The returned `output` is base64-encoded, as the API
   * sends it.
   *
   * @example
   * const { output } = await ukc.instances.get({ name: "web" }).logs({ offset: -4096 });
   * console.log(Buffer.from(output, "base64").toString());
   */
  logs(opts: LogsOptions = {}) {
    const { offset, limit, ...rest } = opts;
    return this.#then((target) =>
      this.#one(
        target,
        this.#instances.api.getInstanceLogs({
          ...toQuery(target.ref),
          ...(offset === undefined ? {} : { offset: [offset] }),
          ...(limit === undefined ? {} : { limit: [limit] }),
          ...call(target, rest),
        }),
      ),
    );
  }

  /** Resource-usage metrics for the instance. */
  metrics(opts: CallOptions = {}) {
    return this.#then((target) =>
      this.#one(
        target,
        this.#instances.api.getInstanceMetrics({
          ...toQuery(target.ref),
          ...call(target, opts),
        }),
      ),
    );
  }

  /** The instance's state-change history. */
  history(opts: CallOptions = {}) {
    return this.#then(async (target) => {
      const res = await this.#instances.api.getInstanceHistory({
        ...toQuery(target.ref),
        ...call(target, opts),
      });
      return unwrapList(res, "instances").map((entry) => withMetro(entry, target.metro));
    });
  }

  /**
   * Chain another operation: it runs against the metro this handle resolved to,
   * after this handle's own operation has completed.
   */
  #then<R>(fetch: (target: MetroTarget) => Promise<R>): InstanceHandle<R> {
    return new InstanceHandle(this.#instances, {
      locate: async () => ({ target: await this.next() }),
      fetch,
      sequential: true,
    });
  }

  /** Unwrap a single-instance response and tag it with the metro it came from. */
  #one<R extends ListEnvelope<"instances">>(target: MetroTarget, work: Promise<R>) {
    return firstTagged(work, "instances", target.metro, `instance ${describeRef(target.ref)}`);
  }
}

/** Per-call options for a plumbing call pinned to one metro. */
function call(target: MetroTarget, opts: CallOptions): CallOptions {
  return { ...opts, baseUrl: target.baseUrl };
}

/**
 * Every instance matching one ref, one per metro — the same name deployed in
 * several metros. Operations run in all of them concurrently and return one
 * result per metro.
 *
 * @example
 * await ukc.instances.each({ name: "web" }).suspend();
 * for (const inst of await ukc.instances.each({ name: "web" })) console.log(inst.metro);
 */
export class InstanceSet extends HandleSet<InstanceHandle<Instance>, Instance> {
  /** Re-read every match's full details. */
  refresh(opts: CallOptions = {}) {
    return this.map((handle) => handle.refresh(opts));
  }

  /** Start every match. */
  start(opts: CallOptions = {}) {
    return this.map((handle) => handle.start(opts));
  }

  /** Stop every match. */
  stop(opts: CallOptions = {}) {
    return this.map((handle) => handle.stop(opts));
  }

  /** Suspend every match. */
  suspend(opts: CallOptions = {}) {
    return this.map((handle) => handle.suspend(opts));
  }

  /** Delete every match. */
  delete(opts: CallOptions = {}) {
    return this.map((handle) => handle.delete(opts));
  }

  /** Apply the same changes to every match. */
  update(changes: InstanceUpdate | InstancePatch[], opts: CallOptions = {}) {
    return this.map((handle) => handle.update(changes, opts));
  }

  /** Stage changes once and apply them to every match. */
  edit(
    opts: CallOptions = {},
  ): ResourceEditor<
    models.MutableInstanceProperty,
    InstanceProperties,
    InstanceMembers,
    Promise<UpdatedInstance[]>
  > {
    return new ResourceEditor(
      (changes) => this.map((handle) => handle.update(changes, opts)),
      "instance",
    );
  }

  /** Wait for every match to reach a state. */
  wait(opts: WaitOptions = {}) {
    return this.map((handle) => handle.wait(opts));
  }

  /** Fetch every match's console log. */
  logs(opts: LogsOptions = {}) {
    return this.map((handle) => handle.logs(opts));
  }

  /** Resource-usage metrics for every match. */
  metrics(opts: CallOptions = {}) {
    return this.map((handle) => handle.metrics(opts));
  }

  /** State-change history for every match. */
  history(opts: CallOptions = {}) {
    return this.map((handle) => handle.history(opts));
  }
}

/**
 * Idiomatic client for Unikraft Cloud instances: envelope-free results,
 * automatic pagination, and metro fan-out. Single-instance operations return a
 * chainable {@link InstanceHandle}.
 *
 * The raw, fully-typed plumbing for this resource stays available on
 * {@link Resource.api}.
 */
export class Instances extends Resource<InstancesApi> {
  protected readonly noun = "instance";

  constructor(session: Session, scope: MetroScope) {
    super(session, scope, new InstancesApi(session.platform));
  }

  /**
   * Create an instance and return a handle to it. Creation targets exactly one
   * metro: the client's, or the default metro when the scope spans several.
   *
   * @example
   * const web = await ukc.metro("fra").instances.create({ image: "nginx:latest" });
   */
  create(spec: CreateInstanceInput, opts: ScopeOptions = {}): InstanceHandle<Instance> {
    // The spec takes `image` as either a plain reference string
    // (`"nginx:latest"`) or a structured `ImageSpec`, so it goes out as given.
    const body: models.CreateInstanceRequest = spec;

    const created = async () => {
      const endpoint = await this.oneEndpoint("Creating an instance", opts);
      const res = await this.api.createInstance({ body, ...this.call(endpoint, opts) });
      const instance = withMetro(
        unwrapFirst(res, "instances", "instance"),
        endpoint.metro,
      ) as Instance;
      const ref: Ref =
        instance.uuid !== undefined ? { uuid: instance.uuid } : ({ name: instance.name } as Ref);
      return { target: this.target(endpoint, ref), value: instance };
    };

    // The create itself is the locate step, so a chained operation waits for it
    // without a redundant read.
    return new InstanceHandle(this, {
      locate: created,
      fetch: (target) => this.fetch(target, opts),
    });
  }

  /**
   * Reference a single instance by `{ name }` or `{ uuid }`. Await the handle to
   * read the instance, or chain an operation onto it.
   *
   * @example
   * const web = await ukc.instances.get({ name: "web" });
   * await ukc.instances.get({ name: "web" }).suspend();
   */
  get(id: InstanceRef, opts: ScopeOptions = {}): InstanceHandle<Instance> {
    return new InstanceHandle(this, {
      locate: () => this.locate(id, opts, (endpoint) => this.#find(endpoint, id, opts)),
      fetch: (target) => this.fetch(target, opts),
    });
  }

  /**
   * Reference every instance matching a ref — one per metro that holds it. A name
   * can exist in several metros at once; this addresses all of them, where
   * {@link Instances.get} insists you pick one.
   *
   * @example
   * await ukc.instances.each({ name: "web" }).suspend();  // in every metro
   * (await ukc.instances.each({ name: "web" })).map((i) => i.metro);
   */
  each(id: InstanceRef, opts: ScopeOptions = {}): InstanceSet {
    return new InstanceSet(async () => {
      const located = await this.locateAll(id, opts, (endpoint) => this.#find(endpoint, id, opts));
      return located.map(
        (hit) =>
          new InstanceHandle<Instance>(this, {
            locate: () => Promise.resolve(hit),
            fetch: (target) => this.fetch(target, opts),
          }),
      );
    });
  }

  /**
   * Lazily iterate every instance in scope, following each metro's pagination
   * and interleaving the metros as their pages arrive. Each instance carries the
   * `metro` it came from.
   *
   * If some metros fail, every healthy metro is drained first and a
   * {@link MetroFanoutError} naming the failures is thrown at the end.
   *
   * @example
   * for await (const inst of ukc.instances.list({ details: true })) {
   *   console.log(inst.metro, inst.name, inst.state);
   * }
   */
  list(opts: ListInstancesOptions = {}): AsyncGenerator<Instance, void, void> {
    const { details, tags, pageSize, ...rest } = opts;
    const self = this;
    return (async function* () {
      const endpoints = await self.endpoints(opts);
      yield* fanout(endpoints, (endpoint) =>
        paginate({
          pageSize,
          cursor: (i) => i.uuid,
          fetchPage: async ({ count, from }) => {
            const res = await self.api.getInstances({
              count,
              from,
              details,
              tags,
              ...self.call(endpoint, rest),
            });
            return unwrapList(res, "instances").map((i) => withMetro(i, endpoint.metro));
          },
        }),
      );
    })();
  }

  /**
   * Delete one or more instances. Refs are located first when the scope spans
   * metros, so each instance is deleted only in the metro that holds it.
   */
  delete(ids: InstanceRef | ReadonlyArray<InstanceRef>, opts: ScopeOptions = {}) {
    return this.#bulk(ids, opts, (group) =>
      this.api.deleteInstances({ body: group.refs, ...this.call(group.endpoint, opts) }),
    );
  }

  /** Start one or more instances. */
  start(ids: InstanceRef | ReadonlyArray<InstanceRef>, opts: ScopeOptions = {}) {
    return this.#bulk(ids, opts, (group) =>
      this.api.startInstances({ body: group.refs, ...this.call(group.endpoint, opts) }),
    );
  }

  /** Stop one or more instances. */
  stop(ids: InstanceRef | ReadonlyArray<InstanceRef>, opts: ScopeOptions = {}) {
    return this.#bulk(ids, opts, (group) =>
      this.api.stopInstances({ body: group.refs, ...this.call(group.endpoint, opts) }),
    );
  }

  /** Suspend one or more instances. */
  suspend(ids: InstanceRef | ReadonlyArray<InstanceRef>, opts: ScopeOptions = {}) {
    return this.#bulk(ids, opts, (group) =>
      this.api.suspendInstances({ body: group.refs, ...this.call(group.endpoint, opts) }),
    );
  }

  /**
   * Change a single instance's properties. Shorthand for `get(id).update(...)`.
   *
   * @example
   * await ukc.instances.update({ name: "web" }, { memory_mb: 512 });
   */
  update(id: InstanceRef, changes: InstanceUpdate | InstancePatch[], opts: ScopeOptions = {}) {
    return this.get(id, opts).update(changes);
  }

  /**
   * Stage several operations against a single instance. Shorthand for
   * `get(id).edit()`.
   *
   * @example
   * await ukc.instances.edit({ name: "web" }).add({ tags: ["prod"] }).apply();
   */
  edit(id: InstanceRef, opts: ScopeOptions = {}): InstanceEditor {
    return this.get(id, opts).edit();
  }

  /** Block until a single instance reaches a state. Shorthand for `get(id).wait(...)`. */
  wait(id: InstanceRef, opts: WaitOptions & ScopeOptions = {}) {
    return this.get(id, opts).wait(opts);
  }

  /** Fetch a single instance's console log. Shorthand for `get(id).logs(...)`. */
  logs(id: InstanceRef, opts: LogsOptions & ScopeOptions = {}) {
    return this.get(id, opts).logs(opts);
  }

  /** Resource-usage metrics for a single instance. Shorthand for `get(id).metrics()`. */
  metrics(id: InstanceRef, opts: ScopeOptions = {}) {
    return this.get(id, opts).metrics(opts);
  }

  /** State-change history for a single instance. Shorthand for `get(id).history()`. */
  history(id: InstanceRef, opts: ScopeOptions = {}) {
    return this.get(id, opts).history(opts);
  }

  /**
   * Read one instance's full details from the metro it was located in.
   *
   * @internal Used by {@link InstanceHandle}.
   */
  async fetch(target: MetroTarget, opts: ScopeOptions = {}): Promise<Instance> {
    const res = await this.api.getInstances({
      ...toQuery(target.ref),
      details: true,
      ...this.call(target, opts),
    });
    return withMetro(
      unwrapFirst(res, "instances", `instance ${describeRef(target.ref)}`),
      target.metro,
    );
  }

  /** Look for one instance in one metro; absent is not a failure. */
  #find(
    endpoint: MetroEndpoint,
    id: InstanceRef,
    opts: ScopeOptions,
  ): Promise<models.Instance | undefined> {
    return orAbsent(
      this.api
        .getInstances({ ...toQuery(id), details: true, ...this.call(endpoint, opts) })
        .then((res) => unwrapList(res, "instances")[0]),
    );
  }

  /** Run a bulk operation once per metro group and tag every result. */
  async #bulk<R extends ListEnvelope<"instances">>(
    ids: InstanceRef | ReadonlyArray<InstanceRef>,
    opts: ScopeOptions,
    each: (group: MetroGroup) => Promise<R>,
  ): Promise<Array<WithMetro<EntryOf<R, "instances">>>> {
    const groups = await this.groupByMetro(ids, opts, (endpoint, ref) =>
      this.#find(endpoint, ref, opts),
    );
    return this.runGroups(groups, (group) =>
      listTagged(each(group), "instances", group.endpoint.metro),
    );
  }
}
