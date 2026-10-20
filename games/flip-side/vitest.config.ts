import { defineConfig } from "vitest/config";

// The tests run in Node. The room tests run the real room, with the Workers runtime module
// swapped for the kit's stub. Some play whole matches, so they get time to spare on a busy machine.
export default defineConfig({
  resolve: { alias: { "cloudflare:workers": "@warrick/kit/testing/cloudflare-workers" } },
  test: { include: ["test/**/*.test.ts"], testTimeout: 60_000 },
});
