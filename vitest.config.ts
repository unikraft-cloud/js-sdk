import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // `test/e2e` boots real virtual machines on a real account. It runs from
    // `vitest.config.e2e.ts` instead, so nothing here can reach a metro and
    // the pull-request checks stay hermetic.
    exclude: ["test/e2e/**", "**/node_modules/**", "**/dist/**"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/api/**", "src/**/*.test.ts"],
    },
  },
});
