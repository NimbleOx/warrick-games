import { defineConfig } from "vitest/config";

// End-to-end checks against a running dev server: `npm run dev`, then `npm run test:live`.
// Set PILL_PANIC_URL if the game isn't at http://localhost:5179/pill-panic.
export default defineConfig({
  test: { include: ["test/live/**/*.test.ts"], testTimeout: 480_000 },
});
