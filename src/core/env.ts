// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

/**
 * Read an environment variable on whichever runtime we are on, and `undefined`
 * everywhere there is no environment to read — a browser, or a worker.
 */
export function readEnv(name: string): string | undefined {
  if (typeof process !== "undefined" && process.env) return process.env[name];
  return undefined;
}
