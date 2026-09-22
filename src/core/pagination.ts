// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

/** Options controlling {@link paginate}. */
export interface PaginateOptions<T> {
  /** Page size passed as the `count` query parameter. */
  pageSize?: number;
  /** Fetch a single page starting after `from` (a cursor, exclusive). */
  fetchPage: (args: { count: number; from?: string }) => Promise<T[]>;
  /** Extract the pagination cursor (typically the UUID) from an item. */
  cursor: (item: T) => string | undefined;
}

const DEFAULT_PAGE_SIZE = 100;

/**
 * Lazily iterate every item across all pages of a list endpoint. The Platform
 * API paginates with a `count` page size and a `from` cursor; a page shorter
 * than `count` marks the end.
 *
 * @example
 * for await (const instance of paginate({ ... })) { ... }
 */
export async function* paginate<T>(opts: PaginateOptions<T>): AsyncGenerator<T, void, void> {
  const count = opts.pageSize && opts.pageSize > 0 ? opts.pageSize : DEFAULT_PAGE_SIZE;
  let from: string | undefined;
  for (;;) {
    const page = await opts.fetchPage({ count, from });
    for (const item of page) yield item;
    if (page.length < count) return;
    const last = page[page.length - 1];
    const next = last === undefined ? undefined : opts.cursor(last);
    // No usable cursor -> stop to avoid an infinite loop.
    if (next === undefined || next === from) return;
    from = next;
  }
}

/** Collect every item of an async iterable into an array. */
export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of it) out.push(item);
  return out;
}
