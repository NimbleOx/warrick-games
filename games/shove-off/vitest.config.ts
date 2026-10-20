import { defineConfig } from "vitest/config";

// The tests run in Node. The room tests run the real room, with the Workers runtime module
// swapped for the kit's stub.
export default defineConfig({
  resolve: { alias: { "cloudflare:workers": "@warrick/kit/testing/cloudflare-workers" } },
  test: { include: ["test/**/*.test.ts"] },
});
