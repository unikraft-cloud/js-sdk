// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// Sandboxes: a virtual machine that runs whatever command you hand it. Run
// with:
//   UKC_TOKEN=... npx tsx examples/sandbox.ts

import { Sandbox, UnikraftCloud, UnikraftCloudError } from "@unikraft/cloud";

async function hotPath() {
  // Nothing is named, so the token comes from `UKC_TOKEN`, the image from
  // `UKC_SANDBOX_IMAGE` or the default, and the metro from `UKC_METRO` or the
  // default. `await using` deletes the sandbox at the end of this scope,
  // however the scope ends.
  await using sandbox = await Sandbox.create();

  const { stdout } = await sandbox.exec("echo hello");
  console.log(stdout); // hello
}

async function configured() {
  // The first argument is the sandbox itself: every field `POST /instances`
  // accepts, plus `rom` and `pluginName` for the plugin underneath.
  const sandbox = await Sandbox.create(
    {
      image: "nginx:latest",
      memory_mb: 1024,
      env: { LOG_LEVEL: "debug" },
      // Your own plugin rom
      rom: "your_org/your_plugin:latest",
    },
    // The second argument configures the client this door builds, and how long
    // the call waits.
    {
      token: process.env.UKC_TOKEN,
      metro: "fra",
      bootTimeoutSeconds: 60,
      ready: { timeoutMs: 30_000 },
    },
  );

  // The instance underneath stays reachable, so its whole surface still works.
  const { name, state, memory_mb } = await sandbox.instance;
  console.log(`${name} in ${sandbox.metro}: ${state}, ${memory_mb} MiB`);

  // A command takes a working directory and its own environment.
  const build = await sandbox.exec("ls -la", { cwd: "/tmp", env: { CI: "1" } });
  console.log(`exit ${build.exitcode}: ${build.stdout}${build.stderr}`);

  // Files go in and come back out.
  await sandbox.mkdir("/work/input");
  await sandbox.writeFile("/work/input/a.txt", "hello\n");
  await sandbox.upload("/work/input", "data.csv", "id,name\n1,fra\n");
  const bytes = await sandbox.readFile("/work/input/a.txt");
  console.log(new TextDecoder().decode(bytes));

  // `start` does not wait, so a command stays under your control: write to
  // its standard input, wait for it, then read its logs. `server.signal("TERM")`
  // ends one that does not stop on its own.
  const server = await sandbox.start("cat", { cwd: "/work" });
  await server.stdin("first line\n");
  await server.stdin("last line\n", { eof: true });
  await server.wait({ timeoutSeconds: 10 });
  const logs = await server.logs();
  console.log(logs.stdout);
  await server.delete();

  // The UUID and the metro are all a later process needs to attach again.
  const again = await Sandbox.connect(
    { uuid: sandbox.uuid, metro: sandbox.metro },
    { token: process.env.UKC_TOKEN },
  );
  console.log(`reconnected to ${again.uuid}`);

  // Without `using`, delete it yourself.
  await sandbox.delete();
}

async function throughAClient() {
  // A client you already have opens the same door, and spends no second token.
  const ukc = new UnikraftCloud({ token: process.env.UKC_TOKEN });
  const sandbox = await ukc.metro("fra").sandboxes.create({ memory_mb: 512 });
  console.log((await sandbox.exec("uname -a")).stdout);

  // Every sandbox in the metro, which is the instance list filtered by plugin.
  for await (const each of ukc.metro("fra").sandboxes.list()) {
    console.log(`- ${each.uuid}`);
  }

  await sandbox.delete();
}

async function main() {
  await hotPath();
  await configured();
  await throughAClient();
}

main().catch((err) => {
  if (err instanceof UnikraftCloudError) {
    console.error(`API error (${err.status ?? "?"}): ${err.message}`);
    process.exit(1);
  }
  throw err;
});
