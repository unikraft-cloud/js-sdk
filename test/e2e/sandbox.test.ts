// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.
//
// The live suite: real virtual machines.
//
// `npm test` does not collect this file. Run it yourself:
//
//   nub run test:e2e          # once
//   nub run test:e2e:watch    # again on every save
//
// with `UKC_TOKEN` in `.env`.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Sandbox, UnikraftCloudError } from "../../src/index.js";
import { liveConfig } from "./live.js";

const { token, metro, image, rom } = liveConfig();

describe("a live sandbox", () => {
  // One machine for the whole file, because a boot is expensive and no test
  // here can disturb another: they run separate commands, on separate paths.
  let sandbox: Sandbox;

  beforeAll(async () => {
    console.info(`booting ${image} in ${metro}`);
    sandbox = await Sandbox.create({ image, rom }, { token, metro });
    console.info(`sandbox ${sandbox.uuid} answers at ${sandbox.baseUrl}`);
  });

  afterAll(async () => {
    // `afterAll` rather than `await using`, because the tests above share one
    // machine. `autokill` is the platform's backstop if this process dies
    // before the delete runs.
    await sandbox?.delete();
  });

  test("`exec` returns the command's own output and exit code", async () => {
    const { stdout, stderr, exitcode } = await sandbox.exec("echo hello");

    expect(stdout).toBe("hello\n");
    expect(stderr).toBe("");
    expect(exitcode).toBe(0);
  });

  test("a failed command reports its exit code instead of throwing", async () => {
    // The plugin answers 200 for a command that ran and failed, so the exit
    // code has to survive `exec`'s five requests rather than become an error.
    const { exitcode } = await sandbox.exec('sh -c "exit 3"');

    expect(exitcode).toBe(3);
  });

  test.each([
    { what: "text, written as UTF-8", data: "hello\n", bytes: [104, 101, 108, 108, 111, 10] },
    // Bytes go up base64 and come back raw, so the two codecs are checked
    // against each other on a payload no UTF-8 decoder can round-trip.
    {
      what: "bytes, written base64",
      data: new Uint8Array([0, 1, 254, 255]),
      bytes: [0, 1, 254, 255],
    },
  ])("a file survives a write and a read: $what", async ({ data, bytes }) => {
    const path = `/tmp/round-trip-${Math.random().toString(36).slice(2)}`;

    await sandbox.writeFile(path, data);

    expect([...(await sandbox.readFile(path))]).toEqual(bytes);
  });

  test("`sandboxes.list` finds the sandbox among the account's instances", async () => {
    // The list is the instance list filtered by an attached plugin named
    // `sandbox`, and only real instance data says whether that filter matches.
    const uuids: string[] = [];
    for await (const found of sandbox.client.metro(sandbox.metro).sandboxes.list()) {
      uuids.push(found.uuid);
    }

    expect(uuids).toContain(sandbox.uuid);
  });
});

test("an `await using` scope deletes the sandbox on the way out", async () => {
  let uuid: string;

  // Its own machine, because the assertion is that the machine is gone.
  {
    await using sandbox = await Sandbox.create({ image, rom }, { token, metro });
    uuid = sandbox.uuid;
    expect((await sandbox.instance).state).toBe("running");
  }

  // The platform reports a missing instance as HTTP 200 with an error envelope,
  // so the 404 comes from the SDK reading the entry's `error` code rather than
  // from the response. That reading is what this checks: the platform still has
  // to answer with the code, and the SDK still has to translate it.
  const err = await Sandbox.connect({ uuid, metro }, { token }).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(UnikraftCloudError);
  expect(err).toMatchObject({ status: 404 });
});
