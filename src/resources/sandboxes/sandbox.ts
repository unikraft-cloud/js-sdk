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

import { SandboxPluginApi } from "../../api/plugins/sandbox/index.js";
import type * as sandboxModels from "../../api/plugins/sandbox/models.gen.js";
import { readEnv } from "../../core/env.js";
import { type CallOptions, UnikraftCloudError } from "../../core/http.js";
import type { Metro, MetroEndpoint, MetroScope } from "../../core/metro.js";
import { pluginBaseUrl } from "../../core/plugin.js";
import { type ReadyPolicy, waitUntilReady } from "../../core/ready.js";
import { unwrap, unwrapList } from "../../core/response.js";
// Cyclic with `index.js`, which owns a `Sandboxes`. Safe: neither module touches
// the other at evaluation time.
import { UnikraftCloud } from "../../index.js";
import { type Instance, type InstanceHandle, Instances } from "../instances.js";
import { Command } from "./command.js";
import {
  DEFAULT_AUTOKILL_MS,
  DEFAULT_BOOT_TIMEOUT_S,
  DEFAULT_IMAGE,
  DEFAULT_MEMORY_MB,
  DEFAULT_PLUGIN_NAME,
  MISSING_TOKEN,
  assertNoClientConfig,
  callOptions,
  encodeFileData,
  started,
  withSandboxPlugin,
  withoutClientConfig,
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
  SandboxSpec,
  StartCommandOptions,
  WriteFileOptions,
} from "./types.js";

/** What a {@link Sandbox} needs to address one plugin in one instance. */
interface SandboxInit {
  client: UnikraftCloud;
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
 * {@link Sandbox.client} is the account.
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
  /** The client whose session this sandbox borrows. */
  readonly client: UnikraftCloud;
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
    this.client = init.client;
    this.uuid = init.uuid;
    this.metro = init.endpoint.metro;
    this.pluginName = init.pluginName;
    this.baseUrl = pluginBaseUrl(init.endpoint.baseUrl, init.uuid, init.pluginName);
    this.api = new SandboxPluginApi({
      ...init.client.session.platform,
      baseUrl: this.baseUrl,
    });
    this.#instances = new Instances(init.client.session, init.endpoint.metro);
  }

  /**
   * Create a sandbox: create the instance with the plugin attached, then wait
   * for the plugin to answer. Credentials come from `token` or `UKC_TOKEN`; pass
   * `client` to borrow one you already have.
   *
   * The image is optional. Without one you get {@link DEFAULT_IMAGE}, or
   * whatever `UKC_SANDBOX_IMAGE` names.
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
   * // The full instance surface, and an explicit token.
   * const sandbox = await Sandbox.create(
   *   { image, memory_mb: 512, env: { LOG_LEVEL: "debug" }, volumes: [...] },
   *   { token, metro: "fra" },
   * );
   */
  static async create(spec: SandboxSpec = {}, opts: SandboxCallOptions = {}): Promise<Sandbox> {
    const client = resolveClient(opts);
    const scope = opts.metros ?? opts.metro ?? client.scope;
    const endpoint = await client.session.resolveOne(scope, "Creating a sandbox");
    return client.metro(endpoint.metro).sandboxes.create(spec, withoutClientConfig(opts));
  }

  /**
   * Attach to a sandbox that already exists. An instance UUID is metro-scoped,
   * so a ref without a metro is searched for across the scope. Name the metro
   * (`{ uuid, metro: "fra" }`) to skip the search.
   *
   * @example
   * const sandbox = await Sandbox.connect({ uuid, metro: "fra" });
   */
  static connect(ref: SandboxRef, opts: ConnectSandboxOptions = {}): Promise<Sandbox> {
    const client = resolveClient(opts);
    const scope = opts.metros ?? opts.metro ?? client.scope;
    return new Sandboxes(client, scope).get(ref, withoutClientConfig(opts));
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
   * @param opts Call options for each probe, headers mostly. `signal` belongs
   *   on the policy, which aborts the wait as well as the request in flight.
   *
   * @example
   * await sandbox.ready({ timeoutMs: 10_000 });
   */
  async ready(policy: ReadyPolicy = {}, opts: CallOptions = {}): Promise<void> {
    const call = {
      ...callOptions(opts),
      ...(policy.signal === undefined ? {} : { signal: policy.signal }),
    };
    // `ListCommands` is the probe the specification nominates
    // (`x-unikraft-plugin-readiness`), and asking it absorbs the boot: a
    // still-booting instance answers 404 or 502, which the loop retries.
    await waitUntilReady(() => this.api.commands.listCommands(call), policy, {
      what: `sandbox ${this.uuid}`,
      diagnose: () => this.#diagnose(),
    });
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
   * Run a command, wait for it to exit, and return its output. Five requests:
   * start, wait, read the exit code, read the logs, delete the record.
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
    const state = await command.inspect(call);
    const logs = await command.logs(call);
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
  async commands(opts: CallOptions = {}): Promise<Command[]> {
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
  readFile(path: string, opts: CallOptions = {}): Promise<Uint8Array> {
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
    await this.delete();
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
  /** The client these sandboxes are created and read through. */
  readonly client: UnikraftCloud;
  /** Which metros these operations cover. */
  readonly scope: MetroScope;

  readonly #instances: Instances;

  constructor(client: UnikraftCloud, scope: MetroScope) {
    this.client = client;
    this.scope = scope;
    this.#instances = new Instances(client.session, scope);
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
    const { rom, pluginName: named, ...instanceSpec } = spec;
    const pluginName = named ?? DEFAULT_PLUGIN_NAME;
    // `||`, not `??`: an empty image is as unusable as an absent one, so it
    // falls through to the next source rather than reaching the platform.
    const image = instanceSpec.image || readEnv("UKC_SANDBOX_IMAGE") || DEFAULT_IMAGE;

    const call = callOptions(opts);
    const instance = await this.#instances.create(
      {
        ...instanceSpec,
        image,
        memory_mb: instanceSpec.memory_mb ?? DEFAULT_MEMORY_MB,
        autokill: instanceSpec.autokill ?? { time_ms: DEFAULT_AUTOKILL_MS },
        plugins: withSandboxPlugin(instanceSpec.plugins, pluginName, rom),
        autostart: true,
        timeout_s: opts.bootTimeoutSeconds ?? DEFAULT_BOOT_TIMEOUT_S,
      },
      call,
    );

    const sandbox = this.#attach(instance, pluginName);
    if (opts.ready !== false) {
      await sandbox.ready(
        {
          ...(call.signal === undefined ? {} : { signal: call.signal }),
          ...opts.ready,
        },
        call,
      );
    }
    return sandbox;
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
          yield self.#attach(instance, wanted);
        }
      }
    })();
  }

  /** Wrap an instance we have already read as a sandbox. */
  #attach(instance: Instance, pluginName: string): Sandbox {
    if (!instance.uuid) {
      throw new UnikraftCloudError(
        "The platform reported an instance with no UUID, so its plugin endpoint cannot be addressed.",
        { kind: "http", body: instance },
      );
    }
    return new Sandbox({
      client: this.client,
      endpoint: this.client.session.endpointFor(instance.metro),
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
function resolveClient(opts: SandboxCallOptions | ConnectSandboxOptions): UnikraftCloud {
  if (opts.client) return opts.client;
  const token = opts.token ?? readEnv("UKC_TOKEN");
  if (token === undefined || token === "") {
    throw new UnikraftCloudError(MISSING_TOKEN, { kind: "config" });
  }
  // Not cached: a module-level default client would be two different variables
  // in this package's dual ESM/CJS build.
  return new UnikraftCloud(opts);
}
