// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// How `exec` collects the output of one command across several reads.

import type { models as sandboxModels } from "@unikraft/cloud-plugin-sandbox-api";
import { fromBase64 } from "../../core/base64.js";
import { type CallOptions, UnikraftCloudError } from "../../core/http.js";
import type { Command } from "./command.js";
import type { ExecResult } from "./types.js";

type Stream = sandboxModels.CommandLogStream;

const STREAMS: readonly Stream[] = ["stdout", "stderr"];

/** What one {@link CollectedOutput.collect} added. */
interface Collected {
  /** The number of new bytes, both streams together. */
  bytes: number;
  /** Whether the read left out bytes, which the raw route then supplied. */
  cut: boolean;
}

/**
 * The output of one command, collected across reads. The plugin addresses a
 * stream by absolute offsets, so each stream keeps the offset of the next byte
 * it needs.
 */
export class CollectedOutput {
  readonly #command: Command;
  readonly #chunks: Record<Stream, Uint8Array[]> = { stdout: [], stderr: [] };
  readonly #next: Record<Stream, number> = { stdout: 0, stderr: 0 };

  constructor(command: Command) {
    this.#command = command;
  }

  /**
   * Collect a read of both streams, then each byte that the read left out, up
   * to the end the read reported.
   *
   * A read without an offset starts where the plugin still holds a stream, and
   * the plugin answers it one page at a time when a log on a volume outgrows
   * the memory for output. The raw route takes a `Range`, so the rest comes
   * from there, from the offset where the read stopped.
   */
  async collect(data: sandboxModels.CommandLogsData, call: CallOptions): Promise<Collected> {
    let bytes = 0;
    let cut = false;
    for (const stream of STREAMS) {
      // A plugin before 1.4.0 sends no `stdout_first`. It cannot release
      // output, so its streams always start at byte 0.
      bytes += this.#add(stream, data[`${stream}_first`] ?? 0, fromBase64(data[stream]));
      const end = data[`${stream}_available`];
      while (this.#next[stream] < end) {
        cut = true;
        const offset = this.#next[stream];
        const rest = await this.#command.logsRaw(stream, { offset, ...call });
        if (rest.length === 0) {
          throw new UnikraftCloudError(
            `The sandbox reported ${end} bytes of ${stream} for command ${this.#command.uuid}, but it sent none from byte ${offset}. Read the rest with \`command.logsRaw("${stream}", { offset: ${offset} })\`.`,
            { kind: "http" },
          );
        }
        bytes += this.#add(stream, offset, rest);
      }
    }
    return { bytes, cut };
  }

  /** What `exec` returns: the command, its exit code, and both streams decoded. */
  result(exitcode: number | null): ExecResult {
    return {
      uuid: this.#command.uuid,
      stdout: this.#text("stdout"),
      stderr: this.#text("stderr"),
      exitcode,
    };
  }

  #text(stream: Stream): string {
    // `stream: true` keeps a character that two reads split until the next
    // chunk completes it, so that it decodes whole and not as two U+FFFD.
    const decoder = new TextDecoder();
    let text = "";
    for (const chunk of this.#chunks[stream]) text += decoder.decode(chunk, { stream: true });
    return text + decoder.decode();
  }

  /** Append the bytes of a stream that start at `first`, past those collected already. */
  #add(stream: Stream, first: number, bytes: Uint8Array): number {
    const next = this.#next[stream];
    if (first > next) {
      throw new UnikraftCloudError(
        `The sandbox no longer holds bytes ${next} to ${first - 1} of ${stream} for command ${this.#command.uuid}: another client released them before \`exec\` read them. Do not release the output of a command while \`exec\` runs it.`,
        { kind: "http" },
      );
    }
    const fresh = bytes.subarray(next - first);
    if (fresh.length > 0) {
      this.#chunks[stream].push(fresh);
      this.#next[stream] = next + fresh.length;
    }
    return fresh.length;
  }
}
