import type { GameIO } from "@warrick/kit/worker/lobby";
import { Room } from "@warrick/kit/worker/room";
import type { ClientMsg, GameState } from "../shared/protocol";
import { Game, newGameState } from "./game";

/**
 * One Durable Object per game code (the kit's Room does sockets, storage and cleanup). Turn
 * timers, CPU turns and the pauses between shots, rounds and the shop all run off its alarm.
 */
export class GameRoom extends Room<GameState, Game> {
  protected newState(code: string, now: number): GameState {
    return newGameState(code, now);
  }

  protected makeGame(state: GameState, io: GameIO): Game {
    return new Game(state, io);
  }

  protected timerAt(state: GameState): number | null {
    return state.timer?.at ?? null;
  }

  protected handle(_ws: WebSocket, game: Game, pid: string, raw: { t: string }): void {
    const msg = raw as ClientMsg;
    switch (msg.t) {
      case "aim":
        return game.aim(pid, msg.aim);
      case "fire":
        return game.fire(pid, msg.aim);
      case "buy":
        return game.buy(pid, msg.item, msg.qty === -1 ? -1 : 1);
      case "ready":
        return game.setReady(pid, msg.ready);
    }
  }
}
