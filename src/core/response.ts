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
 * The part of a `data` list entry that reports the entry's own outcome. Every
 * bulk response repeats this shape once per resource, whatever the resource is.
 */
interface ResultEntry {
  status: string;
  message?: string;
  error?: number;
}

/**
 * The platform's per-entry `error` codes, mapped to the HTTP status that says
 * the same thing. Only the codes the SDK acts on are listed, and an unlisted
 * code leaves the status undefined.
 *
 * Code 8 is "no such resource". The platform answers it with HTTP 200 for a
 * uuid or a name it does not hold, on instances and volumes alike, so the 404
 * is the SDK's reading of the code rather than anything the response carries.
 * {@link orAbsent} depends on that reading: without it, a lookup in a metro
 * that does not hold the resource fails the whole search.
 *
 * The spec publishes no code list. It types `error` as a bare `int32` and gives
 * `8` only as an example, so this map records observed behaviour rather than a
 * documented contract. If the single-resource endpoints ever answer 404,
 * `http.ts` throws before {@link unwrap} runs, and this entry stops being
 * reachable for them.
 */
const ENTRY_ERROR_STATUS: ReadonlyMap<number, number> = new Map([[8, 404]]);

function isFailure(value: unknown): value is ResultEntry {
  return typeof value === "object" && value !== null && (value as ResultEntry).status === "error";
}

/**
 * The `data` payload keys its lists by resource name (`instances`, `volumes`,
 * and so on), and {@link unwrap} is not told which key to read. So this
 * searches every list in the payload.
 */
function firstFailure(data: unknown): ResultEntry | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  for (const value of Object.values(data)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (isFailure(entry)) return entry;
    }
  }
  return undefined;
}

/**
 * Assert that a 2xx response envelope did not report a logical error and return
 * its `data` payload. The plumbing layer already throws on HTTP-level failures;
 * this catches API-level failures reported in an otherwise-200 envelope.
 *
 * @remarks
 * The platform reports a failure in one of two places. A whole-request failure
 * fills the top-level `errors` array. A per-resource failure instead marks the
 * entry inside `data`, so a read of a deleted instance answers HTTP 200 with
 * `status: "error"` and `data.instances[0].error`. Both shapes throw here. The
 * entry supplies the message and the status when the array is absent, because
 * the envelope's own message is only the summary `Failed to perform all
 * operations`.
 *
 * A bulk operation that only partly succeeded reports `status:
 * "partial_success"` and marks its failed entries the same way. That does not
 * throw while the failures stay inside `data`: the caller asked for several
 * resources, and the ones that succeeded are in the same list.
 *
 * The whole envelope stays available on the thrown error's `body`.
 */
export function unwrap<T>(res: Envelope<T>): T {
  const reported = res.errors?.[0];
  if (res.status !== "error" && reported === undefined) return res.data as T;

  const entry = reported === undefined ? firstFailure(res.data) : undefined;
  const code = entry?.error;
  throw new UnikraftCloudError(
    entry?.message ?? res.message ?? "Unikraft Cloud API reported an error",
    {
      kind: "http",
      status: reported?.status ?? (code === undefined ? undefined : ENTRY_ERROR_STATUS.get(code)),
      errors: res.errors,
      body: res,
    },
  );
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
