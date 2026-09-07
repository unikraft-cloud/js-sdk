// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

import { describe, expect, it } from "vitest";
import { base64Codec, nodeBuffer } from "../src/core/base64.js";

// Node always has `Buffer`, so the fallback that every browser, worker, and
// edge runtime takes is the only branch CI does not reach on its own. `Buffer`
// is Node's code, so it is the reference here and not the subject.
const buffer = base64Codec(nodeBuffer);
const fallback = base64Codec(undefined);

describe("base64", () => {
  it.each([
    ["an empty payload", new Uint8Array()],
    ["every byte value", Uint8Array.from({ length: 256 }, (_, i) => i)],
    ["multi-byte text", new TextEncoder().encode("Grüße aus Frankfurt — 🚀")],
  ])("agrees with Buffer on %s", (_case, bytes) => {
    const payload = buffer.toBase64(bytes);

    expect(fallback.toBase64(bytes)).toBe(payload);
    expect(fallback.fromBase64(payload)).toEqual(bytes);
  });

  it("encodes a payload of a size that a log dump reaches", () => {
    // The size at which the spread form fails depends on the stack size of the
    // process, so this payload is a megabyte. That size fails even on a
    // generous stack, and a log read of a megabyte is ordinary.
    const bytes = new Uint8Array(1024 * 1024);

    expect(fallback.toBase64(bytes)).toBe(buffer.toBase64(bytes));
  });

  it("copies decoded bytes out of Buffer's pool", () => {
    // A pooled `Buffer` has a non-zero `byteOffset` and a `.buffer` larger
    // than itself, so these two assertions fail when the decoder returns the
    // `Buffer` instead of a copy.
    const bytes = buffer.fromBase64(buffer.toBase64(new Uint8Array(64)));

    expect(bytes.byteOffset).toBe(0);
    expect(bytes.buffer.byteLength).toBe(bytes.length);
  });

  it("decodes a payload to text", () => {
    expect(buffer.decodeText("aGVsbG8=")).toBe("hello");
  });
});
