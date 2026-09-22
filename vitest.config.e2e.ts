// The live suite's runner. It is a second configuration rather than a flag on
// the first, so that `npm test` cannot reach a metro by accident.

import { defineConfig } from "vitest/config";

// Vitest puts `.env` on `import.meta.env` but leaves `process.env` alone for
// unprefixed names, and the SDK reads `process.env`. Node's own loader fills
// those in and leaves a name the shell already set alone, so
// `UKC_METRO=... npm run test:e2e` still wins over the file.
try {
  process.loadEnvFile(".env");
} catch {
  // No `.env` is the normal case for a run that passes UKC_TOKEN some other
  // way; `liveConfig()` is what reports a missing token.
}

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    environment: "node",
    // Parallel files interleave their output, and the output is what a
    // live run is for.
    fileParallelism: false,
  },
  oxc: { target: "node22" },
});
