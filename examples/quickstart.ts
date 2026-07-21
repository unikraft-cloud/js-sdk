// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// Idiomatic quickstart. Run with:
//   UKC_TOKEN=... npx tsx examples/quickstart.ts

import { UnikraftCloud, UnikraftCloudError } from "@unikraft/cloud";

const ukc = new UnikraftCloud({ token: process.env.UKC_TOKEN });

async function main() {
  // Creating a resource happens in one metro. Name it, and every operation on
  // that client needs no lookup.
  const fra = ukc.metro("fra");

  const instance = await fra.instances.create({
    image: "nginx:latest",
    memory_mb: 256,
    autostart: true,
    service_group: {
      services: [
        {
          port: 443,
          handlers: ["tls", "http"],
          destination_port: 80,
        },
      ],
    },
  });

  console.log(`created ${instance.name} (${instance.uuid}) in ${instance.metro}`);

  // Operations chain off a reference: this waits for the instance to come up,
  // then reads the tail of its console log.
  const { output } = await fra.instances
    .get({ uuid: instance.uuid as string })
    .wait({ state: "running", timeoutSeconds: 30 })
    .logs({ offset: -4096 });

  console.log(Buffer.from(output ?? "", "base64").toString());

  // Without a metro, the client is account-wide: every metro is asked in
  // parallel and the pages are merged as they arrive.
  for await (const inst of ukc.instances.list({ details: true })) {
    console.log(`- ${inst.metro}/${inst.name}: ${inst.state}`);
  }

  // A handle resolves to the metro that actually holds the instance, so the
  // suspend is sent there and nowhere else.
  await ukc.instances.get({ name: instance.name as string }).suspend();

  // Bulk operations take one ref or a list of them.
  await fra.instances.delete([{ uuid: instance.uuid as string }]);
}

main().catch((err) => {
  if (err instanceof UnikraftCloudError) {
    console.error(`API error (${err.status ?? "?"}): ${err.message}`);
    process.exit(1);
  }
  throw err;
});
