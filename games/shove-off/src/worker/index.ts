import { gameWorker } from "@warrick/kit/worker/router";

export { GameRoom } from "./room";

// The zone route only sends warrick.games/shove-off* here; vite.config.ts uses the same base path.
export default gameWorker("shove-off");
