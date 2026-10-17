import { defineConfig } from "vitest/config";

// End-to-end checks against a running dev server: `npm run dev`, then `npm run test:live`.
// Set CURVE_BALL_URL if the game isn't at http://localhost:5175/curve-ball.
export default defineConfig({
  test: { include: ["test/live/**/*.test.ts"], testTimeout: 60_000 },
});
