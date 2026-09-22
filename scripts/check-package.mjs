#!/usr/bin/env node
// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

// The test suite imports `src`, so nothing else in CI loads the package the way
// a consumer does: through the `exports` map, out of what `files` ships. A
// wrong path in either one still passes every other job and only breaks after
// publish. Pack the tarball, unpack it as a dependency, and load each subpath
// from an ESM caller and a CommonJS caller. The CommonJS side also holds the
// premise of the ESM-only build: `require()` of an ESM package works, so
// dropping the CJS output does not drop CJS consumers.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

if (!existsSync(join(root, "dist"))) {
  console.error("dist/ is missing. Run `npm run build` first.");
  process.exit(1);
}

const specifiers = Object.keys(pkg.exports)
  .filter((subpath) => subpath !== "./package.json")
  .map((subpath) => (subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`));

const body = (load) => `
const specifiers = ${JSON.stringify(specifiers, null, 2)};

for (const specifier of specifiers) {
  const mod = ${load};
  const names = Object.keys(mod);
  if (names.length === 0) {
    throw new Error(\`\${specifier} resolves but exports nothing\`);
  }
  if (specifier === ${JSON.stringify(pkg.name)} && typeof mod.UnikraftCloud !== "function") {
    throw new Error("the root entry point does not export UnikraftCloud");
  }
  console.log(\`  ok  \${specifier} (\${names.length} exports)\`);
}
`;

const work = mkdtempSync(join(tmpdir(), "ukc-package-check-"));

try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", work], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  const [{ filename }] = Array.isArray(packed) ? packed : Object.values(packed);

  const installed = join(work, "node_modules", pkg.name);
  mkdirSync(installed, { recursive: true });
  execFileSync("tar", ["-xzf", join(work, filename), "-C", installed, "--strip-components=1"]);

  for (const name of Object.keys(pkg.dependencies ?? {})) {
    cpSync(join(root, "node_modules", name), join(work, "node_modules", name), {
      recursive: true,
      dereference: true,
    });
  }

  // No "type" field: the extensions alone decide how Node.js loads each caller.
  writeFileSync(join(work, "package.json"), '{ "name": "ukc-package-check", "private": true }\n');
  writeFileSync(join(work, "consumer.mjs"), body("await import(specifier)"));
  writeFileSync(join(work, "consumer.cjs"), body("require(specifier)"));

  for (const [kind, consumer] of [
    ["ESM", "consumer.mjs"],
    ["CommonJS", "consumer.cjs"],
  ]) {
    console.log(`${kind} consumer on Node.js ${process.versions.node}:`);
    try {
      execFileSync(process.execPath, [consumer], { cwd: work, stdio: "inherit" });
    } catch {
      // The consumer already reported the failure; a second stack adds nothing.
      console.error(`The ${kind} consumer could not load the packed package.`);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
