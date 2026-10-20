import { defineConfig } from "vitest/config";

// CPU-only games, to measure the CPUs' strength and speed: `npm run sim` (minutes, not seconds,
// so they're not part of `npm test`). SIM_GAMES sets how many games each pairing plays.
export default defineConfig({
  test: { include: ["test/**/*.sim.ts"], testTimeout: 0 },
});
