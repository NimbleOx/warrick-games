import { defineConfig } from "vitest/config";

// The kit's tests run in Node. Room tests swap the Workers runtime module for a stub, the same
// way a game's tests do (see src/testing/room.ts).
export default defineConfig({
  resolve: {
    alias: { "cloudflare:workers": "@warrick/kit/testing/cloudflare-workers" },
  },
  test: { include: ["test/**/*.test.ts"] },
});
