// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// A sandbox spans two APIs. The platform creates the virtual machine and
// attaches the plugin; the plugin's own API runs commands inside it. The plugin
// is addressed under the name it was attached with, not the specification's
// `servers` block, and a sandbox borrows the client's `Session` rather than
// resolving credentials of its own.
//
// Both doors are here: `Sandbox`, which builds a client from its options, and
// `Sandboxes`, which runs through one you already have. They call each other,
// so they share a module rather than a cycle.

import { SandboxPluginApi } from "@unikraft/cloud-plugin-sandbox-api";
import { readEnv } from "../../core/env.js";
import { ApiClient, type CallOptions, UnikraftCloudError } from "../../core/http.js";
import type { Metro, MetroEndpoint, MetroScope } from "../../core/metro.js";
import { pluginBaseUrl } from "../../core/plugin.js";
import { type ReadyPolicy, waitUntilReady } from "../../core/ready.js";
import { explicitEndpoint } from "../../core/resource.js";
import { orAbsent, unwrap, unwrapList } from "../../core/response.js";
import type { Session } from "../../core/session.js";
// Cyclic with `index.js`, which owns a `Sandboxes`. Safe: neither module touches
// the other at evaluation time.
import { UnikraftCloud } from "../../index.js";
import {
  type CreateInstanceInput,
  type Instance,
  type InstanceHandle,
  Instances,
} from "../instances.js";
import { Command } from "./command.js";
import {
  assertNoClientConfig,
  assertSandboxSpec,
  callOptions,
  DEFAULT_AUTOKILL_MS,
  DEFAULT_BOOT_TIMEOUT_S,
  DEFAULT_IMAGE,
  DEFAULT_MEMORY_MB,
  DEFAULT_PLUGIN_NAME,
  encodeFileData,
  MISSING_TOKEN,
  pluginsFromSnapshot,
  started,
  withoutClientConfig,
  withSandboxPlugin,
} from "./options.js";
import type {
  ConnectSandboxOptions,
  CreateSandboxOptions,
  ExecOptions,
  ExecResult,
  GetSandboxOptions,
  ListSandboxesOptions,
  ParentsOptions,
  SandboxCallOptions,
  SandboxRef,
  SandboxRequestOptions,
  SandboxSpec,
  StartCommandOptions,
  WriteFileOptions,
} from "./types.js";

/** What a {@link Sandbox} needs to address one plugin in one instance. */
interface SandboxInit {
  session: Session;
  /**
   * The endpoint the instance was reached through, not just its metro code. A
   * pinned client, or a discovered metro whose endpoint differs from its code,
   * makes the URL unguessable from the code alone.
   */
  endpoint: MetroEndpoint;
  uuid: string;
  pluginName: string;
}

/**
 * A sandbox is one virtual machine with the sandbox plugin attached. Commands
 * and files go to the plugin's own endpoint, a route under that machine.
 *
 * There are two ways in. {@link Sandbox.create} resolves credentials itself;
 * `ukc.metro("fra").sandboxes.create()` borrows a client you already hold. Both
 * give the same object: {@link Sandbox.instance} is the machine, and
 * {@link Sandbox.session} is the credentials and metro knowledge it runs on.
 *
 * @example
 * ```ts
 * import { Sandbox } from "@unikraft/cloud";
 *
 * await using sandbox = await Sandbox.create({ image: "my-org/sandbox-base:latest" });
 *
 * const { stdout, exitcode } = await sandbox.exec("echo hello");
 * await sandbox.writeFile("/tmp/a.txt", "hello");
 *
 * // It is a real virtual machine, so the platform API still applies.
 * await sandbox.instance.update({ memory_mb: 2048 });
 * ```
 */
export class Sandbox implements AsyncDisposable {
  /** The underlying instance's UUID. */
  readonly uuid: string;
  /** The metro the sandbox lives in. An instance UUID resolves in no other. */
  readonly metro: Metro;
  /** The name the plugin is attached under, which is also its URL segment. */
  readonly pluginName: string;
  /**
   * The session this sandbox borrows: one set of credentials, one metro
   * discovery, shared with the client it came from.
   */
  readonly session: Session;
  /** The plugin's endpoint, as {@link pluginBaseUrl} derives it. */
  readonly baseUrl: string;
  /**
   * The raw ("plumbing") plugin API, pinned to this sandbox: every operation in
   * the specification, returning the response envelope untouched.
   *
   * @example
   * const res = await sandbox.api.commands.listCommands();
   * res.data?.commands;
   */
  readonly api: SandboxPluginApi;

  readonly #instances: Instances;

  /**
   * @internal Build a sandbox with {@link Sandbox.create},
   * {@link Sandbox.connect}, or `ukc.metro("fra").sandboxes`.
   */
  constructor(init: SandboxInit) {
    this.session = init.session;
    this.uuid = init.uuid;
    this.metro = init.endpoint.metro;
    this.pluginName = init.pluginName;
    this.baseUrl = pluginBaseUrl(init.endpoint.baseUrl, init.uuid, init.pluginName);
    // The SDK's own transport, so a plugin failure is the SDK's own
    // `UnikraftCloudError`. A plugin-specific token would be set here.
    this.api = new SandboxPluginApi(
      new ApiClient({ ...init.session.platform, baseUrl: this.baseUrl }),
    );
    this.#instances = new Instances(init.session, init.endpoint.metro);
  }

  /**
   * Create a sandbox: create the instance with the plugin attached, then wait
   * for the plugin to answer. Credentials come from `token` or `UKC_TOKEN`; pass
   * `client` to borrow one you already have.
   *
   * The image is optional. Without one you get {@link DEFAULT_IMAGE}, or
   * whatever `UKC_SANDBOX_IMAGE` names.
   *
   * A `template`, a `branch_from` source, or a `checkpoint` replaces the image.
   * The snapshot carries the image, the memory and the plugins of its source,
   * so the sandbox plugin comes with it: leave `rom` out, and pass `pluginName`
   * only when the source attached the plugin under another name.
   *
   * The sandbox goes to one metro: `metro`, or `metros` naming a single one, or
   * `UKC_METRO`, or the default. Name a full `http(s)://` URL as the `metro` to
   * work against a staging or self-hosted cluster; the plugin endpoint is then
   * derived from that cluster.
   *
   * @example
   * // Credentials and image from the environment.
   * await using sandbox = await Sandbox.create();
   *
   * @example
   * // A specific image.
   * await using sandbox = await Sandbox.create({ image: "my-org/instance-image:latest" });
   *
   * @example
   * // A template saved from an earlier sandbox, plugin included.
   * await using sandbox = await Sandbox.create({ template: { name: "my-template" } });
   *
   * @example
   * // The full instance surface, and an explicit token.
   * const sandbox = await Sandbox.create(
   *   { image, memory_mb: 512, env: { LOG_LEVEL: "debug" }, volumes: [...] },
   *   { token, metro: "fra" },
   * );
   */
  static async create(spec: SandboxSpec = {}, opts: SandboxCallOptions = {}): Promise<Sandbox> {
    const client = resolveClient(opts, "`Sandbox.create(spec, { client })`");
    const scope = opts.metros ?? opts.metro ?? client.scope;
    const endpoint = await client.session.resolveOne(scope, "Creating a sandbox");
    return new Sandboxes(client.session, endpoint.metro).create(spec, withoutClientConfig(opts));
  }

  /**
   * Attach to a sandbox that already exists. An instance UUID is metro-scoped,
   * so a ref without a metro is searched for across the scope. Name the metro
   * (`{ uuid, metro: "fra" }`) to skip the search.
   *
   * @example
   * const sandbox = await Sandbox.connect({ uuid, metro: "fra" });
   */
  // `async` so a synchronous failure, a missing token mostly, rejects the
  // returned promise as `create` does, instead of throwing before it exists.
  static async connect(ref: SandboxRef, opts: ConnectSandboxOptions = {}): Promise<Sandbox> {
    const client = resolveClient(opts, "`Sandbox.connect(ref, { client })`");
    const scope = opts.metros ?? opts.metro ?? client.scope;
    return new Sandboxes(client.session, scope).get(ref, withoutClientConfig(opts));
  }

  /**
   * The instance underneath, as a chainable handle. Each access returns a fresh
   * handle that reads the instance when awaited, so keep the result if you need
   * it twice.
   *
   * @example
   * const { state, memory_mb } = await sandbox.instance;
   * await sandbox.instance.update({ memory_mb: 2048 });
   */
  get instance(): InstanceHandle<Instance> {
    return this.#instances.get({ uuid: this.uuid, metro: this.metro });
  }

  /**
   * Wait until the plugin answers. `create` does this for you; call it after a
   * `create({ ready: false })`, or to wait again on a sandbox that was suspended.
   *
   * @param policy How long to keep asking, and how fast.
   * @param opts Call options for each probe, headers mostly. A `signal` here
   *   aborts the whole wait, as one on the policy does; give it in either
   *   place, or in both.
   *
   * @example
   * await sandbox.ready({ timeoutMs: 10_000 });
   */
  async ready(policy: ReadyPolicy = {}, opts: SandboxRequestOptions = {}): Promise<void> {
    const call = callOptions(opts);
    // A wait is reached two ways, and each carries cancellation in its own
    // place: `ready({ signal })` names the policy, `sandboxes.get(ref, { ready:
    // {}, signal })` names the call. They mean the same thing, so honour both.
    const cancel = anySignal(policy.signal, call.signal);
    const deadline: ReadyPolicy = {
      ...policy,
      ...(cancel === undefined ? {} : { signal: cancel }),
    };
    // `ListCommands` is the probe the specification nominates
    // (`x-unikraft-plugin-readiness`), and asking it absorbs the boot: a
    // still-booting instance answers 404 or 502, which the loop retries.
    //
    // The waiter's signal carries both the policy's signal and the deadline,
    // so a probe in flight stops when either fires.
    await waitUntilReady(
      (signal) => this.api.commands.listCommands({ ...call, signal }),
      deadline,
      {
        what: `sandbox ${this.uuid}`,
        diagnose: () => this.#diagnose(),
      },
    );
  }

  /**
   * Name the cause once a readiness wait has run out of time. A silent plugin
   * is the symptom; the cause is usually one layer below it, and the instance's
   * own state reports it. Costs one request, on a path that has already failed.
   */
  async #diagnose(): Promise<string | undefined> {
    // Deliberately unsignalled: this runs after the deadline, to explain it.
    const instance = await this.instance;

    // The plugin name is a segment of the endpoint, so a name that no attached
    // plugin carries gives a 404 on every probe. `plugins` is optional on the
    // wire, which makes an absent list "unknown" rather than "none attached".
    const plugins = instance.plugins;
    const plugin = plugins?.find((p) => p.name === this.pluginName);

    if (instance.state === "running") {
      if (plugins !== undefined && plugin === undefined) {
        const names = plugins.map((p) => `\`${p.name}\``);
        return names.length === 0
          ? `the instance is running but carries no plugin at all, so nothing answers at \`${this.pluginName}\`. A plugin is attached when the instance is created, which \`sandboxes.create()\` does for you`
          : `the instance is running but carries no plugin named \`${this.pluginName}\`, only ${names.join(", ")}. Pass the name it does carry as \`pluginName\``;
      }
      const rom =
        plugin === undefined
          ? ""
          : ` and that its ROM (\`${plugin.rom}\`) is a sandbox plugin image`;
      return `the instance is running, so it is the sandbox plugin that did not answer. Read the instance's console log (\`sandbox.instance.logs()\`), which carries the plugin's own output${rom}`;
    }

    // The platform wakes a sleeping instance to serve a plugin request, so
    // standby by itself does not explain the timeout. See
    // https://unikraft.com/docs/features/plugins
    if (instance.state === "standby") {
      return 'the instance is in "standby", asleep. A plugin request wakes an instance that scale-to-zero put to sleep, so this is a slow wake rather than a refusal: raise `ready: { timeoutMs }`. If you suspended the instance yourself, bring it up first (`sandbox.instance.start()`, then `sandbox.instance.wait({ state: "running" })`) and call `sandbox.ready()` again';
    }

    if (instance.state === "starting") {
      return 'the instance is still "starting", so nothing has failed and it only needs longer. Raise `ready: { timeoutMs }`, or `bootTimeoutSeconds` on `create`, which waits for `running` before the first probe';
    }

    const exit =
      instance.exit_code === undefined ? "" : `, having exited with code ${instance.exit_code}`;
    // `state` is a free-form string on the wire, so it can also be absent.
    const state =
      instance.state === undefined
        ? "the instance reported no state"
        : `the instance is "${instance.state}"`;

    // An instance that never ran is a different failure from one that ran and
    // exited, and it wants different advice: its console log is empty, so
    // pointing at the log sends the caller to look at nothing. An image or a
    // plugin ROM that could not be pulled lands here, such as a private image
    // or a typo in a ROM name.
    if (!started(instance)) {
      const roms = [
        `\`${instance.image}\``,
        ...(plugin === undefined ? [] : [`\`${plugin.rom}\``]),
      ];
      return `${state} and never started, so nothing inside it has run yet. The usual cause is an image the platform could not fetch or boot: check that ${roms.join(" or ")} ${roms.length > 1 ? "both exist" : "exists"}, that the name is spelled as the registry has it, and that this account can read ${roms.length > 1 ? "them" : "it"}`;
    }

    return `${state}${exit}, and the sandbox plugin runs inside the instance, so nothing answers while the instance is down. Start it again (\`sandbox.instance.start()\`) and read the console log (\`sandbox.instance.logs()\`); a base image whose main process exits immediately stops the instance with it`;
  }

  /**
   * Run a command, wait for it to exit, and return its output. Five requests
   * over four round trips: start, wait, then the exit code and the logs
   * together, then delete the record.
   *
   * A `timeoutSeconds` that runs out is not an error: you get the output so far
   * and `exitcode: null`, and the command is left running and addressable as
   * `sandbox.command(uuid)`.
   *
   * @example
   * const { stdout, exitcode } = await sandbox.exec("echo hello");
   * const { stdout } = await sandbox.exec("ls", { cwd: "/tmp" });
   */
  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const { keep, timeoutSeconds, cwd, env, ...rest } = opts;
    const call = callOptions(rest);

    const command = await this.start(cmd, {
      ...(cwd === undefined ? {} : { cwd }),
      ...(env === undefined ? {} : { env }),
      ...call,
    });
    await command.wait({
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
      ...call,
    });
    // Two reads of unrelated state, so they go together: one round trip
    // instead of two, on the path a caller times.
    const [state, logs] = await Promise.all([command.inspect(call), command.logs(call)]);
    const finished = state.exitcode !== null;
    if (!keep && finished) await command.delete(call);

    return {
      uuid: command.uuid,
      stdout: logs.stdout,
      stderr: logs.stderr,
      exitcode: state.exitcode,
    };
  }

  /**
   * Start a command and return immediately, without waiting for it to exit.
   *
   * @example
   * const server = await sandbox.start("python -m http.server", { cwd: "/srv" });
   * await server.signal("TERM");
   */
  async start(cmd: string, opts: StartCommandOptions = {}): Promise<Command> {
    const { cwd, env, ...rest } = opts;
    const res = await this.api.commands.runCommand({
      body: {
        cmd,
        ...(cwd === undefined ? {} : { cwd }),
        ...(env === undefined ? {} : { env }),
      },
      ...callOptions(rest),
    });
    const uuid = unwrap(res)?.uuid;
    if (uuid === undefined) {
      throw new UnikraftCloudError("The sandbox started a command but reported no UUID for it.", {
        kind: "http",
        body: res,
      });
    }
    return new Command(this, uuid);
  }

  /** Every command the sandbox knows about, in the order they were started. */
  async commands(opts: SandboxRequestOptions = {}): Promise<Command[]> {
    const res = await this.api.commands.listCommands(callOptions(opts));
    return unwrapList(res, "commands").map((uuid) => new Command(this, uuid));
  }

  /**
   * Address a command by UUID, without a request. Useful after
   * `exec(cmd, { keep: true })`.
   */
  command(uuid: string): Command {
    return new Command(this, uuid);
  }

  /**
   * Read a file, as bytes.
   *
   * @example
   * const bytes = await sandbox.readFile("/tmp/a.txt");
   * console.log(new TextDecoder().decode(bytes));
   */
  readFile(path: string, opts: SandboxRequestOptions = {}): Promise<Uint8Array> {
    // The raw read, not the base64 one, which costs 33 % more bytes.
    return this.api.fs.readRawFile({ body: { path }, ...callOptions(opts) });
  }

  /**
   * Write a file, creating it if it is missing. A string is written as UTF-8;
   * bytes are sent base64-encoded.
   *
   * @example
   * await sandbox.writeFile("/tmp/a.txt", "hello");
   * await sandbox.writeFile("/tmp/a.log", "more\n", { append: true });
   */
  async writeFile(
    path: string,
    data: string | Uint8Array,
    opts: WriteFileOptions = {},
  ): Promise<void> {
    const { append, ...rest } = opts;
    unwrap(
      await this.api.fs.writeFile({
        body: { path, append: append ?? false, ...encodeFileData(data) },
        ...callOptions(rest),
      }),
    );
  }

  /**
   * Create a directory. Missing parents are created unless you say otherwise.
   *
   * @example
   * await sandbox.mkdir("/tmp/work/in/progress");
   */
  async mkdir(path: string, opts: ParentsOptions = {}): Promise<void> {
    const { parents, ...rest } = opts;
    unwrap(
      await this.api.fs.createDirectory({
        body: { path, parents: parents ?? true },
        ...callOptions(rest),
      }),
    );
  }

  /**
   * Upload a file into a directory. `filename` is the name to give it when
   * `path` is a directory.
   *
   * @example
   * await sandbox.upload("/tmp", "data.csv", bytes);
   */
  async upload(
    path: string,
    filename: string,
    data: string | Uint8Array,
    opts: ParentsOptions = {},
  ): Promise<void> {
    const { parents, ...rest } = opts;
    unwrap(
      await this.api.fs.uploadFile({
        body: {
          path,
          filename,
          parents: parents ?? true,
          ...encodeFileData(data),
        },
        ...callOptions(rest),
      }),
    );
  }

  /** Delete the sandbox, which deletes the instance underneath it. */
  async delete(opts: CallOptions = {}): Promise<void> {
    await this.instance.delete(opts);
  }

  /**
   * Delete the sandbox at the end of an `await using` scope, however the scope
   * ends.
   *
   * @example
   * await using sandbox = await Sandbox.create({ image });
   * // deleted here, exception or not
   */
  async [Symbol.asyncDispose](): Promise<void> {
    // A scope that deleted the sandbox itself still ends here, and the platform
    // reports the second delete as "no such instance". Throwing then would fail
    // a block that succeeded, and where the block threw as well, bury its error
    // inside a `SuppressedError` the caller is not expecting.
    await orAbsent(this.delete());
  }
}

/**
 * The sandboxes of one metro, as `ukc.metro("fra").sandboxes`. Every method is
 * an alias of the matching {@link Sandbox} entry point with the client and metro
 * filled in. It hangs off a metro client because a sandbox lives in exactly one
 * metro, so `ukc.sandboxes.create()` could only ever mean the default, quietly.
 *
 * @example
 * const sandbox = await ukc.metro("fra").sandboxes.create({ image, memory_mb: 512 });
 * for await (const sb of ukc.metro("fra").sandboxes.list()) console.log(sb.uuid);
 */
export class Sandboxes {
  /** The session these sandboxes are created and read through. */
  readonly session: Session;
  /** Which metros these operations cover. */
  readonly scope: MetroScope;

  readonly #instances: Instances;

  constructor(session: Session, scope: MetroScope) {
    this.session = session;
    this.scope = scope;
    this.#instances = new Instances(session, scope);
  }

  /**
   * Create a sandbox in this metro. An alias of {@link Sandbox.create}, minus
   * the options that build a client: this one runs through the client you
   * reached it through, and takes its metro from it.
   *
   * @example
   * const sandbox = await ukc.metro("fra").sandboxes.create({ image, env: { A: "1" } });
   */
  async create(spec: SandboxSpec = {}, opts: CreateSandboxOptions = {}): Promise<Sandbox> {
    assertNoClientConfig(opts, "`sandboxes.create()`");
    assertSandboxSpec(spec);
    const { rom, pluginName: named, image: namedImage, ...instanceSpec } = spec;
    const pluginName = named ?? DEFAULT_PLUGIN_NAME;
    // `template`, `branch_from` and `checkpoint` create from a snapshot, which
    // carries the image, the memory and the plugins of its source. The platform
    // answers 400 to `memory_mb` next to one, and refuses a second entry for a
    // plugin the snapshot already carries, so those defaults apply only when
    // the spec names no snapshot.
    const fromSnapshot =
      instanceSpec.template !== undefined ||
      instanceSpec.branch_from !== undefined ||
      instanceSpec.checkpoint !== undefined;
    // `||`, not `??`: an empty image is as unusable as an absent one, so it
    // falls through to the next source rather than reaching the platform.
    const image =
      namedImage || (fromSnapshot ? undefined : readEnv("UKC_SANDBOX_IMAGE") || DEFAULT_IMAGE);
    const memory_mb = fromSnapshot
      ? instanceSpec.memory_mb
      : (instanceSpec.memory_mb ?? DEFAULT_MEMORY_MB);
    const plugins = fromSnapshot
      ? pluginsFromSnapshot(instanceSpec.plugins, pluginName, rom)
      : withSandboxPlugin(instanceSpec.plugins, pluginName, rom);

    const call = callOptions(opts);
    const instance = await this.#createInstance(
      {
        ...instanceSpec,
        ...(image === undefined ? {} : { image }),
        ...(memory_mb === undefined ? {} : { memory_mb }),
        autokill: instanceSpec.autokill ?? { time_ms: DEFAULT_AUTOKILL_MS },
        ...(plugins === undefined ? {} : { plugins }),
        autostart: true,
        // A nonzero `timeout_s` makes the platform wait for `running`, which
        // `ready: false` promises not to do; zero sends no wait at all.
        timeout_s: opts.bootTimeoutSeconds ?? (opts.ready === false ? 0 : DEFAULT_BOOT_TIMEOUT_S),
      },
      call,
    );

    const sandbox = this.#attach(instance, pluginName);
    if (opts.ready !== false) {
      try {
        // `ready` reads the call's signal as well as the policy's, so the
        // caller's cancellation reaches the wait without being copied here.
        await sandbox.ready(opts.ready ?? {}, call);
      } catch (err) {
        // This call created the machine, so a failure here would leak it:
        // `autokill` counts stopped time only, and a running instance with a
        // silent plugin never stops on its own. The readiness error stays the
        // one thrown, because it carries the diagnosis. The delete must not
        // reuse the caller's signal, which is aborted when the caller gave up.
        const deleted = await sandbox
          .delete({ ...(call.headers && { headers: call.headers }) })
          .then(
            () => true,
            () => false,
          );
        if (deleted && err instanceof UnikraftCloudError) {
          err.message +=
            " The sandbox was deleted. To inspect a sandbox that fails like this, create it with `{ ready: false }`, which skips this wait and keeps the sandbox for you to probe and delete yourself.";
        }
        throw err;
      }
    }
    return sandbox;
  }

  /**
   * Create the instance, and say what a caller can do when the request itself
   * fails rather than the plugin behind it.
   *
   * The reply is what carries the UUID, so a request that fails on the way
   * back leaves nothing to address: the caller's `signal` fired during the
   * boot wait, or the connection dropped, and the platform may have built the
   * machine anyway. The wait below deletes what it made; this cannot, because
   * it never learned what that was.
   */
  async #createInstance(spec: CreateInstanceInput, call: CallOptions): Promise<Instance> {
    try {
      return await this.#instances.create(spec, call);
    } catch (err) {
      // `autokill` measures stopped time, so an instance that booted and is
      // running is not removed by it, and nothing else here knows of it.
      if (err instanceof UnikraftCloudError && err.kind === "network") {
        err.message +=
          " The platform may have created the instance before this failed. If it did, it is running, and neither this call nor `autokill` removes it: find it with `sandboxes.list()` and delete it.";
      }
      throw err;
    }
  }

  /**
   * Attach to an existing sandbox in this metro. An alias of
   * {@link Sandbox.connect}, minus the options that build a client.
   *
   * @example
   * const sandbox = await ukc.metro("fra").sandboxes.get({ uuid });
   */
  async get(ref: SandboxRef, opts: GetSandboxOptions = {}): Promise<Sandbox> {
    assertNoClientConfig(opts, "`sandboxes.get()`");
    const call = callOptions(opts);
    const instance = await this.#instances.get(ref, call);
    const sandbox = this.#attach(instance, this.#pluginName(instance, opts.pluginName));
    if (opts.ready !== undefined && opts.ready !== false) await sandbox.ready(opts.ready, call);
    return sandbox;
  }

  /**
   * Every instance in scope carrying the sandbox plugin, as sandboxes. A
   * sandbox is an instance, so this is the instance list, filtered.
   *
   * @example
   * for await (const sandbox of ukc.metro("fra").sandboxes.list()) {
   *   await sandbox.delete();
   * }
   */
  list(opts: ListSandboxesOptions = {}): AsyncGenerator<Sandbox, void, void> {
    const { pluginName, ...rest } = opts;
    const wanted = pluginName ?? DEFAULT_PLUGIN_NAME;
    const self = this;
    return (async function* () {
      for await (const instance of self.#instances.list({
        ...rest,
        details: true,
      })) {
        if (instance.plugins?.some((plugin) => plugin.name === wanted)) {
          yield self.#attach(instance, wanted, rest.baseUrl);
        }
      }
    })();
  }

  /**
   * Wrap an instance we have already read as a sandbox.
   */
  #attach(instance: Instance, pluginName: string, baseUrl?: string): Sandbox {
    if (!instance.uuid) {
      throw new UnikraftCloudError(
        "The platform reported an instance with no UUID, so its plugin endpoint cannot be addressed.",
        { kind: "http", body: instance },
      );
    }
    return new Sandbox({
      session: this.session,
      endpoint:
        baseUrl !== undefined
          ? explicitEndpoint(baseUrl)
          : this.session.endpointFor(instance.metro),
      uuid: instance.uuid,
      pluginName,
    });
  }

  /**
   * Work out which plugin on an instance is the sandbox: the name the caller
   * gave, the conventional one, or the only one there is.
   */
  #pluginName(instance: Instance, requested?: string): string {
    const plugins = instance.plugins;
    const names = (plugins ?? []).map((plugin) => plugin.name);

    if (requested !== undefined) {
      // An instance read without details reports no plugins, which is not
      // evidence of absence; only a populated list can contradict.
      if (plugins !== undefined && !names.includes(requested)) {
        throw new UnikraftCloudError(
          `Instance ${instance.uuid} carries no plugin named "${requested}"${
            names.length > 0 ? ` (it has: ${names.join(", ")})` : " (it has no plugins)"
          }.`,
          { kind: "http", status: 404, body: instance },
        );
      }
      return requested;
    }

    if (names.includes(DEFAULT_PLUGIN_NAME)) return DEFAULT_PLUGIN_NAME;
    const only = names[0];
    if (names.length === 1 && only !== undefined) return only;
    if (names.length === 0) {
      throw new UnikraftCloudError(
        `Instance ${instance.uuid} has no plugins attached, so it is not a sandbox.`,
        { kind: "http", status: 404, body: instance },
      );
    }
    throw new UnikraftCloudError(
      `Instance ${instance.uuid} carries ${names.length} plugins (${names.join(
        ", ",
      )}) and none is named "${DEFAULT_PLUGIN_NAME}". Say which one with \`{ pluginName }\`.`,
      { kind: "config", body: instance },
    );
  }
}

/**
 * Resolve the client a sandbox operation runs through: the caller's, or one
 * built from the configuration a `new UnikraftCloud()` would take. Going
 * through the client is deliberate, because it is the only place credentials
 * are resolved.
 */
function resolveClient(
  opts: SandboxCallOptions | ConnectSandboxOptions,
  door: string,
): UnikraftCloud {
  if (opts.client) {
    // A borrowed client carries its own credentials and transport, so anything
    // naming those here is spent on nothing and then dropped. `metro` and
    // `metros` are not among them: this door does read them, to pick which
    // metro the sandbox goes to.
    assertNoClientConfig(opts, door, ["client", "metro", "metros"]);
    return opts.client;
  }
  const token = opts.token ?? readEnv("UKC_TOKEN");
  if (token === undefined || token === "") {
    throw new UnikraftCloudError(MISSING_TOKEN, { kind: "config" });
  }
  // Not cached: a module-level default client would be two different variables
  // in this package's dual ESM/CJS build.
  return new UnikraftCloud(opts);
}

/** One signal that aborts as soon as any of the given ones does. */
function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const given = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (given.length < 2) return given[0];
  return AbortSignal.any(given);
}
