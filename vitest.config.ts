import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Each worker loads the TypeScript compiler for project preparation. On
    // 8-core/16 GB hosts the default worker count causes memory pressure and
    // spurious 5s timeouts, so cap concurrency and allow a realistic budget.
    maxWorkers: 3,
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
    },
  },
});
