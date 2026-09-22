// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// Small URL helpers shared by the transport and the metro resolution. Kept
// internal: not re-exported from the package entry point.

/** Character code of "/". */
const SLASH = 47;

/**
 * Remove every trailing "/" from a URL.
 */
export function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === SLASH) end--;
  return end === url.length ? url : url.slice(0, end);
}
