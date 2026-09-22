// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// Changing an instance's properties. Run with:
//   UKC_TOKEN=... npx tsx examples/update.ts

import { UnikraftCloud, UnikraftCloudError } from "@unikraft/cloud";

const ukc = new UnikraftCloud({ token: process.env.UKC_TOKEN });
const web = ukc.metro("fra").instances.get({ name: "web" });

async function main() {
  // A patch object: a value sets the property, `null` removes it, and anything
  // omitted is left alone. One request, whatever you pass.
  const updated = await web.update({
    memory_mb: 512,
    vcpus: 2,
    env: { LOG_LEVEL: "debug" },
    autokill: null,
  });

  console.log(`${updated.name} in ${updated.metro}: ${updated.status}`);

  // When `set` is not what you mean — merge into a property, or remove single
  // members — stage the operations and apply them together.
  await web
    .edit()
    .set({ hostname: "web-1" })
    .add({ env: { FEATURE_X: "1" }, tags: ["prod"] })
    .del({ env: ["LOG_LEVEL"], tags: ["staging"] })
    .apply();

  // `apply()` returns a handle, so the chain continues.
  await web.edit().set({ memory_mb: 1024 }).apply().wait({ state: "running" });

  // The raw triples remain available for anything the typed map does not cover.
  await ukc
    .metro("fra")
    .instances.update({ name: "web" }, [{ prop: "memory_mb", op: "set", value: 256 }]);
}

main().catch((err) => {
  if (err instanceof UnikraftCloudError) {
    console.error(`API error (${err.status ?? "?"}): ${err.message}`);
    process.exit(1);
  }
  throw err;
});
