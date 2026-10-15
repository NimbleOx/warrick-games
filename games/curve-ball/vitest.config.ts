import { defineConfig } from "vitest/config";

// Pure game logic tests run in Node; they don't need the Workers runtime.
// test/live needs a running server; see vitest.live.config.ts.
export default defineConfig({
  test: { include: ["test/*.test.ts"] },
});
