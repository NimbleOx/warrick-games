import { defineConfig } from "vitest/config";

// End-to-end checks against a running dev server: `npm run dev`, then `npm run test:live`.
// Set CURVE_BALL_URL if the server isn't on http://localhost:5175.
export default defineConfig({
  test: { include: ["test/live/**/*.test.ts"], testTimeout: 60_000 },
});
