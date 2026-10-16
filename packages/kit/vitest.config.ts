import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The kit's tests run in Node. Room tests swap the Workers runtime module for a stub.
export default defineConfig({
  resolve: {
    alias: { "cloudflare:workers": fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url)) },
  },
  test: { include: ["test/**/*.test.ts"] },
});
