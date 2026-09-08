// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// The sandbox surface, as one module. Split by layer behind this file:
// `types.ts` for what a call accepts, `options.ts` for the defaults and the
// plumbing, `command.ts` and `sandbox.ts` for the two classes. Import from
// here, or from `@unikraft/cloud`, rather than from one of the parts.

export { Command } from "./command.js";
export {
  DEFAULT_AUTOKILL_MS,
  DEFAULT_BOOT_TIMEOUT_S,
  DEFAULT_PLUGIN_NAME,
  DEFAULT_PLUGIN_ROM,
} from "./options.js";
export { Sandbox, Sandboxes } from "./sandbox.js";
export type {
  CommandLogs,
  ConnectSandboxOptions,
  CreateSandboxOptions,
  ExecOptions,
  ExecResult,
  GetSandboxOptions,
  ListSandboxesOptions,
  LogsRawOptions,
  ParentsOptions,
  SandboxCallOptions,
  SandboxRef,
  SandboxRequestOptions,
  SandboxSpec,
  StartCommandOptions,
  StdinOptions,
  WaitCommandOptions,
  WriteFileOptions,
} from "./types.js";
