import { defineConfig } from "vitest/config";

// The tests run in Node. Room tests run the real Durable Object through the kit's harness, with
// the Workers runtime module swapped for the kit's stub.
export default defineConfig({
  resolve: {
    alias: { "cloudflare:workers": "@warrick/kit/testing/cloudflare-workers" },
  },
  test: { include: ["test/**/*.test.ts"] },
});
