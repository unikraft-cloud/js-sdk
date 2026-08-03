// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

import { type ResponseError, UnikraftCloudError } from "./http.js";
import type { Metro } from "./metro.js";

/** The subset of the response envelope the idiomatic layer inspects. */
export interface Envelope<T> {
  // Most responses are "success" | "error", but some (e.g. autoscale) use extra
  // statuses like "unconfigured"; only "error" is treated as a failure.
  status: string;
  message?: string;
  errors?: ReadonlyArray<ResponseError>;
  data?: T;
}

/**
 * Assert that a 2xx response envelope did not report a logical error and return
 * its `data` payload. The plumbing layer already throws on HTTP-level failures;
 * this catches API-level failures reported in an otherwise-200 envelope.
 *
 * @remarks
 * A bulk operation that only partly succeeded (`status: "partial_success"`)
 * carries entries in `errors` and so throws too. The whole envelope — including
 * the `data` for the parts that did succeed — is available on the thrown
 * error's `body`.
 */
export function unwrap<T>(res: Envelope<T>): T {
  if (res.status === "error" || (res.errors && res.errors.length > 0)) {
    throw new UnikraftCloudError(res.message ?? "Unikraft Cloud API reported an error", {
      kind: "http",
      status: res.errors?.[0]?.status,
      errors: res.errors,
      body: res,
    });
  }
  return res.data as T;
}

/**
 * Unwrap an envelope and return the first element of one of its list fields,
 * throwing a descriptive error if the list is empty. Most single-resource
 * operations return the resource inside a singleton array.
 */
export function unwrapFirst<T, K extends keyof T>(
  res: Envelope<T>,
  key: K,
  what: string,
): NonNullable<T[K]> extends readonly (infer E)[] ? E : never {
  const data = unwrap(res);
  const list = data?.[key] as unknown as unknown[] | undefined;
  const first = list?.[0];
  if (first === undefined) {
    throw new UnikraftCloudError(`${what} not found`, { kind: "http", status: 404, body: res });
  }
  return first as never;
}

/**
 * Unwrap an envelope and return one of its list fields as an array (empty when
 * the field is absent).
 */
export function unwrapList<T, K extends keyof T>(
  res: Envelope<T>,
  key: K,
): NonNullable<T[K]> extends readonly (infer E)[] ? E[] : never {
  const data = unwrap(res);
  return ((data?.[key] as unknown as unknown[] | undefined) ?? []) as never;
}

/**
 * Resolve to `undefined` when a lookup reports that the resource is not there,
 * rather than throwing. Searching several metros for one resource means most of
 * them will legitimately answer "not here"; only a real failure should count as
 * a failure.
 */
export async function orAbsent<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof UnikraftCloudError && err.status === 404) return undefined;
    throw err;
  }
}

/**
 * A resource reference: exactly one of `uuid` or `name`. The two are mutually
 * exclusive because the API validates every value it is given — sending a name
 * in the `uuid` filter fails with `Invalid uuid '<name>'` — so a caller has to
 * say which kind of identifier they hold.
 *
 * A name is only unique within a metro: the same name can exist in several, or
 * in every one. Add `metro` to say which you mean, which also saves the SDK a
 * lookup. A `uuid` identifies one resource wherever it lives, so it never needs
 * qualifying.
 *
 * @example
 * await ukc.instances.get({ name: "web" });
 * await ukc.instances.get({ name: "web", metro: "fra" });
 * await ukc.instances.get({ uuid: "550e8400-e29b-41d4-a716-446655440000" });
 */
export type Ref =
  | { uuid: string; name?: never; metro?: Metro }
  | { name: string; uuid?: never; metro?: Metro };

/** A reference as the API accepts it: the identifier alone, without a metro. */
export type WireRef = { uuid: string; name?: never } | { name: string; uuid?: never };

// `Array.isArray` does not narrow a ReadonlyArray out of a union on its own.
function isRefList(value: Ref | ReadonlyArray<Ref>): value is ReadonlyArray<Ref> {
  return Array.isArray(value);
}

/** Normalise a single {@link Ref} or a list of them into a list. */
export function toRefs(refs: Ref | ReadonlyArray<Ref>): Ref[] {
  return isRefList(refs) ? [...refs] : [refs];
}

/**
 * Strip a {@link Ref} down to what goes on the wire. `metro` says *where* to
 * send the request, so it must not travel inside the request body — the API
 * would reject the unknown field.
 */
export function wireRef(ref: Ref): WireRef {
  if (ref.uuid !== undefined) return { uuid: ref.uuid };
  if (ref.name !== undefined) return { name: ref.name };
  throw new TypeError("A resource reference needs either a `uuid` or a `name`.");
}

/** Build the single-key `{ uuid }` or `{ name }` query filter for a {@link Ref}. */
export function toQuery(ref: Ref): { name?: string[]; uuid?: string[] } {
  if (ref.uuid !== undefined) return { uuid: [ref.uuid] };
  if (ref.name !== undefined) return { name: [ref.name] };
  // Only reachable from untyped JavaScript; the API would reject an empty filter.
  throw new TypeError("A resource reference needs either a `uuid` or a `name`.");
}

/** Describe a {@link Ref} for use in error messages. */
export function describeRef(ref: Ref): string {
  const id = ref.uuid !== undefined ? `uuid "${ref.uuid}"` : `name "${String(ref.name)}"`;
  return ref.metro === undefined ? id : `${id} in ${ref.metro}`;
}
