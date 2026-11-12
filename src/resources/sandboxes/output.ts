// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// How `exec` collects the output of one command across several reads. A
// sandbox plugin holds only so much unread output for a command, and from
// 1.4.0 on a client can release what it has read. A command whose unread
// output fills its share waits in its next write until a client releases some.

import type { models as sandboxModels } from "@unikraft/cloud-plugin-sandbox-api";
import { fromBase64 } from "../../core/base64.js";
import { type CallOptions, UnikraftCloudError } from "../../core/http.js";
import type { Command } from "./command.js";
import { MAX_WAIT_SLICE_S } from "./options.js";
import type { ExecResult } from "./types.js";

type Stream = sandboxModels.CommandLogStream;

const STREAMS: readonly Stream[] = ["stdout", "stderr"];

/**
 * How much output a command may write between two reads of `exec`, in bytes:
 * half of the 16 MiB a sandbox plugin holds for one command at most, so that
 * the command does not fill its share while `exec` waits.
 */
export const READ_EVERY_BYTES = 8 * 1024 * 1024;

/**
 * How long `exec` waits for a command to exit before it reads the output
 * again, in seconds.
 *
 * A command at its output limit writes nothing until a release, so it gets
 * the next read at once. A quiet command needs few reads, so the wait doubles
 * after each read, up to {@link MAX_WAIT_SLICE_S}. The rate that the command
 * wrote at since the last read also limits the wait, so that the command
 * writes less than {@link READ_EVERY_BYTES} in it and does not reach its limit
 * while `exec` waits.
 */
export function nextWait(previous: number, capped: boolean, bytes: number, seconds: number) {
  if (capped) return 0;
  const doubled = Math.min(MAX_WAIT_SLICE_S, Math.max(1, previous * 2));
  return bytes === 0 ? doubled : Math.min(doubled, (READ_EVERY_BYTES * seconds) / bytes);
}

interface Collected {
  /** The number of new bytes, both streams together. */
  bytes: number;
  /** Whether the read left out bytes, which the raw route then supplied. */
  cut: boolean;
}

/**
 * The output of one command, collected across reads. The plugin addresses a
 * stream by absolute offsets, so each stream keeps the offset of the next byte
 * it needs, which is also how far the stream can be released.
 */
export class CollectedOutput {
  readonly #command: Command;
  readonly #chunks: Record<Stream, Uint8Array[]> = { stdout: [], stderr: [] };
  readonly #next: Record<Stream, number> = { stdout: 0, stderr: 0 };
  #released: Record<Stream, number> = { stdout: 0, stderr: 0 };

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

  /**
   * Release what was collected and not released yet, so that a command at its
   * output limit continues. One request, and none when nothing is new.
   */
  async release(call: CallOptions): Promise<void> {
    if (STREAMS.every((stream) => this.#next[stream] === this.#released[stream])) return;
    const upTo = { ...this.#next };
    await this.#command.releaseLogs({ ...upTo, ...call });
    this.#released = upTo;
  }

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
