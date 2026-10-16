import type { GameIO } from "@warrick/kit/worker/lobby";
import { Room } from "@warrick/kit/worker/room";
import { TICK_MS } from "../shared/constants";
import type { ClientMsg, GameState } from "../shared/protocol";
import { Game, newGameState, type Live } from "./game";

/**
 * One Durable Object per game code (the kit's Room does sockets, storage and cleanup). Players'
 * moves are handled as they arrive; while a round is on and someone is connected, the tick loop
 * moves the CPUs and drops rocks on anyone who's stopped moving.
 */
export class GameRoom extends Room<GameState, Game, Live> {
  protected readonly tickMs = TICK_MS;

  protected newState(code: string, now: number): GameState {
    return newGameState(code, now);
  }

  protected makeGame(state: GameState, io: GameIO, live: Live | null): Game {
    return new Game(state, io, live);
  }

  protected wantsLoop(state: GameState): boolean {
    return state.phase === "playing" && !!this.live;
  }

  /** A round whose boards were lost (the object restarted) starts over. */
  protected afterHello(game: Game): void {
    game.recover();
  }

  protected welcome(game: Game): object {
    // The welcome carries the boards; don't send them twice.
    game.outbox = game.outbox.filter((m) => m.t !== "snap");
    return { snap: game.snapshot() };
  }

  protected handle(_ws: WebSocket, game: Game, pid: string, raw: { t: string }): void {
    const msg = raw as ClientMsg;
    if (msg.t === "mv") game.move(pid, msg);
  }
}
