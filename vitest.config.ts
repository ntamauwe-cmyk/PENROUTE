import { defineConfig } from "vitest/config";
import path from "node:path";

// Backend integration tests: executes the REAL Convex queries, mutations,
// actions, HTTP actions and scheduled functions in-memory via convex-test.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    testTimeout: 30_000,
  },
});
