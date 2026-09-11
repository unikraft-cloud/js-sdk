// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// A `Sandboxes` type takes the per-call options, and the matching `Sandbox`
// entry point takes those plus the configuration a client is built from.

import type * as models from "../../api/platform/models.gen.js";
import type * as sandboxModels from "../../api/plugins/sandbox/models.gen.js";
import type { CallOptions } from "../../core/http.js";
import type { MetroScope } from "../../core/metro.js";
import type { ReadyPolicy } from "../../core/ready.js";
import type { Ref } from "../../core/response.js";
import type { UnikraftCloud, UnikraftCloudConfig } from "../../index.js";

/** Reference(s) accepted by sandbox operations: `{ uuid }` or `{ name }`. */
export type SandboxRef = Ref;

/**
 * What a sandbox is: every field `POST /instances` accepts, plus two shorthands
 * for the plugin. `autostart` and `timeout_s` are set for you, because a plugin
 * cannot answer in a stopped instance; `wait_timeout_ms` and `replicas` are
 * excluded, because a `Sandbox` addresses exactly one instance.
 *
 * `memory_mb` defaults to {@link DEFAULT_MEMORY_MB}, and `autokill` to
 * {@link DEFAULT_AUTOKILL_MS}. Write either field to replace the default.
 */
export type SandboxSpec = Omit<
  models.CreateInstanceRequest,
  "autostart" | "timeout_s" | "wait_timeout_ms" | "replicas"
> & {
  /**
   * The plugin's ROM. Defaults to {@link DEFAULT_PLUGIN_ROM}. Shorthand for one
   * entry in `plugins`; attach the plugin there instead when you also need its
   * `config`, and then omit `rom`.
   */
  rom?: string | models.ImageSpec;
  /**
   * The plugin name, which is also its URL segment. Defaults to
   * {@link DEFAULT_PLUGIN_NAME}.
   */
  pluginName?: string;
};

/**
 * The per-call options a sandbox honours. `baseUrl` is not among them: a plugin
 * call's base URL is the plugin's own endpoint, so a metro root there would send
 * `/commands` to the platform API. See {@link callOptions}.
 */
export type SandboxRequestOptions = Omit<CallOptions, "baseUrl">;

/**
 * Options for `sandboxes.create()`: how the call behaves, waiting and
 * cancellation. What the sandbox is goes in {@link SandboxSpec}.
 *
 * Credentials and the metro are absent on purpose, because this door runs
 * through a client that already carries both. {@link SandboxCallOptions} adds
 * them for {@link Sandbox.create}, which has no client yet.
 */
export interface CreateSandboxOptions extends SandboxRequestOptions {
  /**
   * How long the create call waits for the virtual machine to reach `running`,
   * in seconds. Defaults to {@link DEFAULT_BOOT_TIMEOUT_S}. Raise it for an
   * image that is large or not yet cached in the metro.
   */
  bootTimeoutSeconds?: number;
  /**
   * How to wait for the plugin to answer, or `false` to return as soon as the
   * instance exists. See {@link ReadyPolicy}.
   *
   * `create` waits by default, having just booted the instance. `connect` and
   * `sandboxes.get()` do not, since the sandbox was already there. Pass
   * `ready: {}` there to probe anyway, after a start or a resume from
   * `standby`, where the plugin reloads.
   */
  ready?: ReadyPolicy | false;
}

/**
 * Options for `sandboxes.get()`: {@link CreateSandboxOptions} minus the
 * create-only ones, plus the plugin name, which a connect cannot read from a
 * spec it is never given.
 */
export type GetSandboxOptions = Omit<CreateSandboxOptions, "bootTimeoutSeconds"> & {
  /**
   * The plugin name to address. Defaults to the sandbox plugin found on the
   * instance, or {@link DEFAULT_PLUGIN_NAME}.
   */
  pluginName?: string;
};

/**
 * Options for {@link Sandbox.create}: {@link CreateSandboxOptions} plus the
 * configuration a client is built from, since this door builds one. Extends
 * {@link UnikraftCloudConfig}, so `{ token }` works inline; pass `client` to
 * borrow an existing client instead.
 */
export interface SandboxCallOptions extends UnikraftCloudConfig, CreateSandboxOptions {
  /** Borrow an existing client's session instead of building one. */
  client?: UnikraftCloud;
}

/**
 * Options for {@link Sandbox.connect}: {@link SandboxCallOptions} minus the
 * create-only ones, plus the plugin name.
 */
export type ConnectSandboxOptions = Omit<SandboxCallOptions, "bootTimeoutSeconds"> & {
  /**
   * The plugin name to address. Defaults to the sandbox plugin found on the
   * instance, or {@link DEFAULT_PLUGIN_NAME}.
   */
  pluginName?: string;
};

/** Options for `sandboxes.list()`. */
export interface ListSandboxesOptions extends CallOptions {
  /** Metros this call covers, overriding the client's scope. */
  metros?: MetroScope;
  /** Only list instances carrying a plugin of this name. */
  pluginName?: string;
  /** Filter by tags. */
  tags?: string[];
  /** Page size used while auto-paginating. */
  pageSize?: number;
}

/**
 * Options for {@link Sandbox.start}. `cwd` and `env` go into the run request as
 * they are, so they are the plugin's own fields rather than copies of them.
 */
export type StartCommandOptions = CallOptions &
  Pick<sandboxModels.RunCommandRequest, "cwd" | "env">;

/** Options for {@link Sandbox.exec}. */
export interface ExecOptions extends StartCommandOptions {
  /**
   * Keep the command record afterwards, so its logs can be read again through
   * `sandbox.command(uuid)`. By default `exec` deletes it.
   */
  keep?: boolean;
  /** Give up waiting after this many seconds. Decimals are accepted. */
  timeoutSeconds?: number;
}

/**
 * What a finished command produced: its identity and exit code as the plugin
 * reports them, plus both output streams decoded.
 *
 * `exitcode` is `null` when `timeoutSeconds` ran out. The command then keeps
 * running, and its record survives whether or not `keep` was given, so `uuid`
 * stays addressable as `sandbox.command(uuid)`.
 */
export interface ExecResult extends Pick<sandboxModels.GetCommandData, "uuid" | "exitcode"> {
  /** Everything the command wrote to standard output, decoded from base64. */
  stdout: string;
  /** Everything the command wrote to standard error, decoded from base64. */
  stderr: string;
}

/**
 * A command's output: both streams decoded, and the total size of each, which a
 * {@link Command.logsRaw} range can then address.
 */
export interface CommandLogs
  extends Pick<sandboxModels.CommandLogsData, "stdout_available" | "stderr_available"> {
  /** The standard output stream, decoded from base64. */
  stdout: string;
  /** The standard error stream, decoded from base64. */
  stderr: string;
}

/** Options for {@link Command.wait}. */
export interface WaitCommandOptions extends CallOptions {
  /**
   * Give up after this many seconds and return; decimals are accepted. Without
   * it the call blocks until the command exits.
   */
  timeoutSeconds?: number;
}

/** Options for {@link Command.logsRaw}. */
export interface LogsRawOptions extends CallOptions {
  /**
   * First byte to read. A negative value reads that many bytes from the end of
   * the stream, and cannot be combined with `limit`.
   */
  offset?: number;
  /** Maximum number of bytes to read. */
  limit?: number;
}

/** Options for {@link Command.stdin}. */
export interface StdinOptions extends CallOptions {
  /** Close standard input after writing this data. */
  eof?: boolean;
}

/** Options for {@link Sandbox.writeFile}. */
export interface WriteFileOptions extends CallOptions {
  /** Append to the file instead of truncating it. Defaults to `false`. */
  append?: boolean;
}

/** Options for {@link Sandbox.mkdir} and {@link Sandbox.upload}. */
export interface ParentsOptions extends CallOptions {
  /** Create missing parent directories. Defaults to `true`. */
  parents?: boolean;
}
