import { gameWorker } from "@warrick/kit/worker/router";

export { GameRoom } from "./room";

// The zone route only sends warrick.games/liars-dice* here; vite.config.ts uses the same base path.
export default gameWorker("liars-dice");
