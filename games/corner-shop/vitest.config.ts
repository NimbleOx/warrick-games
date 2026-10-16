import { defineConfig } from "vitest/config";

// Pure game logic tests run in Node; they don't need the Workers runtime.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
