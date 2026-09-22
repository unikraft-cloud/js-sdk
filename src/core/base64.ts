// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// Base64 on whichever runtime we are on. `Buffer` is native code, and it is
// much faster for the payloads that arrive this way (log dumps and file
// reads), so it is the fast path where it exists. `btoa` and `atob` carry
// every runtime that has no `Buffer`, such as a browser, a worker, or an edge
// runtime.

/** The part of Node's `Buffer` that the codec uses. */
interface BufferLike {
  from(input: string | Uint8Array, encoding?: string): Uint8Array & { toString(e: string): string };
}

export const nodeBuffer = (globalThis as { Buffer?: BufferLike }).Buffer;

/**
 * The codec for one runtime.
 *
 * The `Buffer` is a parameter, and not a read of `globalThis.Buffer` inside
 * each function, so a caller can select the fallback on a runtime that has
 * `Buffer`. The parameter holds no default, because JavaScript applies a
 * default to an explicit `undefined` argument, which removes that choice.
 */
export function base64Codec(buffer: BufferLike | undefined) {
  /** Encode bytes as base64, which is how the plugin accepts binary payloads. */
  function toBase64(bytes: Uint8Array): string {
    if (buffer) return buffer.from(bytes).toString("base64");
    // The loop replaces `String.fromCharCode(...bytes)`. The spread form
    // passes one argument for each byte, so it throws a `RangeError` when the
    // payload fills the call stack.
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  /** Decode base64 into bytes. Every log and file payload arrives this way. */
  function fromBase64(text: string): Uint8Array {
    // This copies the bytes out of the `Buffer` on purpose. A `Buffer` is a
    // view into a pooled `ArrayBuffer`, so a return of the `Buffer` itself
    // would expose its neighbours through `.buffer`, `.byteOffset`, or a later
    // `subarray`.
    if (buffer) return new Uint8Array(buffer.from(text, "base64"));
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /** Decode a base64 payload into a string. Users never see base64. */
  function decodeText(base64: string): string {
    return new TextDecoder().decode(fromBase64(base64));
  }

  return { toBase64, fromBase64, decodeText };
}

export const { toBase64, fromBase64, decodeText } = base64Codec(nodeBuffer);
