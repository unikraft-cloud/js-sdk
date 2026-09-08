// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// One command inside a sandbox, addressed by the UUID the plugin assigned it.

import type * as sandboxModels from "../../api/plugins/sandbox/models.gen.js";
import { decodeText, toBase64 } from "../../core/base64.js";
import type { CallOptions } from "../../core/http.js";
import { unwrap } from "../../core/response.js";
import { callOptions, rangeHeader } from "./options.js";
// Type-only, and so erased: a `Command` belongs to a `Sandbox`, which builds it.
import type { Sandbox } from "./sandbox.js";
import type { CommandLogs, LogsRawOptions, StdinOptions, WaitCommandOptions } from "./types.js";

/**
 * A command inside a sandbox. Each method is exactly one request, so a caller
 * can see what a wait costs.
 *
 * @example
 * const command = await sandbox.start("sleep 30");
 * await command.signal("TERM");
 * const { stdout } = await command.logs();
 */
export class Command {
  /** The command's UUID, assigned by the plugin. */
  readonly uuid: string;
  /** The sandbox the command runs in. */
  readonly sandbox: Sandbox;

  constructor(sandbox: Sandbox, uuid: string) {
    this.sandbox = sandbox;
    this.uuid = uuid;
  }

  /**
   * Read the command's command line, working directory and `exitcode`, which is
   * `null` while it runs. The only operation that reports the exit code.
   */
  async inspect(opts: CallOptions = {}): Promise<sandboxModels.GetCommandData> {
    const res = await this.sandbox.api.commands.getCommandByUuid(this.uuid, callOptions(opts));
    return unwrap(res);
  }

  /**
   * Block until the command exits.
   *
   * @example
   * await command.wait();                       // however long it takes
   * await command.wait({ timeoutSeconds: 5 });  // then return regardless
   */
  async wait(opts: WaitCommandOptions = {}): Promise<void> {
    const { timeoutSeconds, ...rest } = opts;
    const call = callOptions(rest);
    if (timeoutSeconds === undefined) {
      unwrap(await this.sandbox.api.commands.waitForCommand(this.uuid, call));
      return;
    }
    unwrap(
      await this.sandbox.api.commands.waitForCommandWithTimeout(this.uuid, {
        body: { timeout_s: timeoutSeconds },
        ...call,
      }),
    );
  }

  /** Both output streams, decoded. */
  async logs(opts: CallOptions = {}): Promise<CommandLogs> {
    const res = await this.sandbox.api.commands.getCommandLogs(this.uuid, callOptions(opts));
    const data = unwrap(res);
    return {
      stdout: decodeText(data.stdout),
      stderr: decodeText(data.stderr),
      stdout_available: data.stdout_available,
      stderr_available: data.stderr_available,
    };
  }

  /**
   * One output stream as bytes, optionally a byte range of it.
   *
   * @remarks
   * The range goes in a `Range` header. The plugin also models it as a body on
   * the JSON log `GET`, which `fetch` forbids and drops silently.
   *
   * @example
   * const tail = await command.logsRaw("stdout", { offset: -4096 });
   * console.log(new TextDecoder().decode(tail));
   */
  // `async` so an invalid range rejects the returned promise. A synchronous
  // throw would pass the caller's `.catch()` by.
  async logsRaw(
    stream: sandboxModels.CommandLogStream,
    opts: LogsRawOptions = {},
  ): Promise<Uint8Array> {
    const { offset, limit, ...rest } = opts;
    const range = rangeHeader(offset, limit);
    return this.sandbox.api.commands.getRawCommandLog(this.uuid, stream, {
      ...(range === undefined ? {} : { Range: range }),
      ...callOptions(rest),
    });
  }

  /**
   * Feed data into the command's standard input.
   *
   * @example
   * await command.stdin("hello\n");
   * await command.stdin("", { eof: true });
   */
  async stdin(data: string | Uint8Array, opts: StdinOptions = {}): Promise<void> {
    const { eof, ...rest } = opts;
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    unwrap(
      await this.sandbox.api.commands.writeCommandStdin(this.uuid, {
        body: { data: toBase64(bytes), ...(eof === undefined ? {} : { eof }) },
        ...callOptions(rest),
      }),
    );
  }

  /**
   * Send a signal to the command, as a number or a name.
   *
   * @example
   * await command.signal("TERM");   // or 15, or "SIGTERM"
   */
  async signal(signal: number | string, opts: CallOptions = {}): Promise<void> {
    unwrap(
      await this.sandbox.api.commands.signalCommand(this.uuid, {
        body: { signal },
        ...callOptions(opts),
      }),
    );
  }

  /** Delete the command record and its logs. */
  async delete(opts: CallOptions = {}): Promise<void> {
    unwrap(await this.sandbox.api.commands.deleteCommandByUuid(this.uuid, callOptions(opts)));
  }

  /** Delete the command's logs, keeping the command record. */
  async deleteLogs(opts: CallOptions = {}): Promise<void> {
    unwrap(await this.sandbox.api.commands.deleteCommandLogsByUuid(this.uuid, callOptions(opts)));
  }
}
