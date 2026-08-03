// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// Using the low-level "plumbing" API directly. Every method returns the raw
// response envelope exactly as described by the OpenAPI specification, and each
// client talks to exactly one metro. Reach for this when you need a field or an
// operation the idiomatic layer does not expose yet.
//
//   UKC_TOKEN=... npx tsx examples/plumbing.ts

import { ControlPlaneApi } from "@unikraft/cloud/api/controlplane";
import { InstancesApi, PlatformApi } from "@unikraft/cloud/api/platform";

const token = process.env.UKC_TOKEN;

// One resource at a time...
const instances = new InstancesApi({
  baseUrl: "https://api.fra.unikraft.cloud",
  token,
});

// ...or every platform resource behind one config.
const platform = new PlatformApi({
  baseUrl: "https://api.fra.unikraft.cloud",
  token,
});

// The control plane is global rather than metro-scoped.
const controlplane = new ControlPlaneApi({
  baseUrl: "https://controlplane.unikraft.cloud",
  token,
});

async function main() {
  const res = await instances.getInstances({ count: 10, details: true });
  console.log(`status: ${res.status}, op_time_us: ${res.op_time_us}`);
  for (const inst of res.data?.instances ?? []) {
    console.log(`- ${inst.name}`);
  }

  const quotas = await platform.users.getUser();
  console.log(quotas.data?.quotas);

  // Ask the control plane where the metros are, then aim a single call at one of
  // them with a per-call `baseUrl` — this is the fan-out the idiomatic layer
  // does for you.
  const metros = (await controlplane.metros.listMetros()).data?.metros ?? [];
  for (const metro of metros) {
    const there = await instances.getInstances({ count: 1, baseUrl: metro.endpoint });
    console.log(`${metro.iata_code}: ${there.data?.instances?.length ?? 0} instance(s)`);
  }
}

main();
