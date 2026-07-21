// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// Writes per-directory package.json markers into the dual-build output so Node
// interprets dist/esm as ES modules and dist/cjs as CommonJS, regardless of the
// root package.json "type".

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const markers = [
  ["dist/esm/package.json", { type: "module" }],
  ["dist/cjs/package.json", { type: "commonjs" }],
];

for (const [rel, contents] of markers) {
  const path = resolve(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`);
  console.log(`wrote ${rel}`);
}
