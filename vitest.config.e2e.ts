// The live suite's runner. It is a second configuration rather than a flag on
// the first, so that `npm test` cannot reach a metro by accident.

import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Vitest puts `.env` on `import.meta.env` but leaves `process.env` alone for
// unprefixed names, and the SDK reads `process.env`. Only names the shell has
// not set are filled in, so `UKC_METRO=... npm run test:e2e` still wins over
// the file.
for (const [key, value] of Object.entries(loadEnv("test", process.cwd(), ""))) {
  if (process.env[key] === undefined) process.env[key] = value;
}

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    environment: "node",
    // Parallel files interleave their output, and the output is what a
    // live run is for.
    fileParallelism: false,
  },
  // `await using` is a syntax error on Node 22, which this package supports, so
  // esbuild has to lower it.
  esbuild: { target: "node20" },
});
