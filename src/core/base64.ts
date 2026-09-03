// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// Base64 on whichever runtime we are on. `Buffer` is native code and much
// faster for the payloads that arrive this way — log dumps and file reads — so
// it is the fast path where it exists; `btoa`/`atob` carry every runtime that
// has no `Buffer`, such as a browser, a worker, or an edge runtime.

/** Node's `Buffer`, when running on a runtime that has it. */
const nodeBuffer = (
  globalThis as {
    Buffer?: {
      from(
        input: string | Uint8Array,
        encoding?: string,
      ): Uint8Array & { toString(e: string): string };
    };
  }
).Buffer;

/** Encode bytes as base64, which is how the plugin accepts binary payloads. */
export function toBase64(bytes: Uint8Array): string {
  if (nodeBuffer) return nodeBuffer.from(bytes).toString("base64");
  // Built in a loop, not `String.fromCharCode(...bytes)`: the spread form
  // exceeds the argument limit and blows the stack on a payload of any size.
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decode base64 into bytes. Every log and file payload arrives this way. */
function fromBase64(text: string): Uint8Array {
  // Copied out of the `Buffer` on purpose: a `Buffer` is a view into a pooled
  // `ArrayBuffer`, so handing it back would expose its neighbours through
  // `.buffer`, `.byteOffset`, or a later `subarray`.
  if (nodeBuffer) return new Uint8Array(nodeBuffer.from(text, "base64"));
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decode a base64 payload into a string. Users never see base64. */
export function decodeText(base64: string): string {
  return new TextDecoder().decode(fromBase64(base64));
}
