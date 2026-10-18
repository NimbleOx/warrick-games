import { gameWorker } from "@warrick/kit/worker/router";

export { GameRoom } from "./room";

// The zone route only sends warrick.games/stack-attack* here; vite.config.ts uses the same base path.
export default gameWorker("stack-attack");
