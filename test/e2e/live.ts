// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// What a live run needs, and the one thing that makes a run fail for a reason
// of its own rather than for anything the SDK did.

/**
 * Where a live run goes when nothing names a metro: the internal staging
 * deployment, which tracks the `prod-staging` platform branch. It is the one
 * place a platform fix can be checked before the OpenAPI specification catches
 * up with it.
 */
const METRO = "http://api.ukp-staging.apw.unikraft.internal";

/**
 * The image the live suite boots, which is deliberately not the SDK's
 * `DEFAULT_IMAGE`. That default names the official slim image, and until the
 * official image is published the suite would fail on a missing image rather
 * than on anything it means to test. Drop this pin once that image exists.
 */
const IMAGE = "debian-slim:latest";

/**
 * The sandbox plugin ROM the live suite attaches, which is deliberately not
 * the SDK's `DEFAULT_PLUGIN_ROM`. That default names the `:latest` tag, which
 * is not published yet, so a sandbox created without this pin never boots its
 * plugin. Drop this pin once `:latest` exists.
 */
const ROM = "plugins/sandbox:staging";

/** What one live sandbox needs. */
export interface LiveConfig {
  token: string;
  metro: string;
  image: string;
  rom: string;
}

/** A variable that is set but empty is as absent as one that is unset. */
function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * The configuration for a live run, or a failure that says what to set. Call
 * it at the top of a file: a missing token should stop the file before it
 * boots anything, not halfway through a hook.
 */
export function liveConfig(): LiveConfig {
  const token = env("UKC_TOKEN");
  if (token === undefined) {
    throw new Error(
      "The live suite needs an account: UKC_TOKEN is missing or empty. Put a token in `.env` " +
        "(copy `.env.example`). Keep the trailing `=` padding when you copy it: a truncated " +
        "token answers 401 on every deployment, which reads as an expired one.",
    );
  }
  return {
    token,
    metro: env("UKC_METRO") ?? METRO,
    image: env("UKC_SANDBOX_IMAGE") ?? IMAGE,
    rom: env("UKC_SANDBOX_ROM") ?? ROM,
  };
}
