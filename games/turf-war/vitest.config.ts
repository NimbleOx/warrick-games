import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Pure game logic tests run in Node; they don't need the Workers runtime. The room test runs the
// real room, with the Workers runtime module swapped for a stub.
export default defineConfig({
  resolve: {
    alias: { "cloudflare:workers": fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url)) },
  },
  test: { include: ["test/**/*.test.ts"] },
});
