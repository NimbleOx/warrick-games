import type { GameIO } from "@warrick/kit/worker/lobby";
import { Room } from "@warrick/kit/worker/room";
import type { ClientMsg, GameState } from "../shared/protocol";
import { Game, newGameState } from "./game";

/**
 * One Durable Object per game code (the kit's Room does sockets, storage and cleanup). The
 * turn clock, the CPUs' attacks, the end-of-turn dice drop and the winner's banner all run
 * off its alarm, so between actions the room can hibernate.
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
      case "attack":
        return game.attack(pid, msg.from, msg.to);
      case "end":
        return game.endTurn(pid);
      case "takeover":
        return game.takeover(pid, msg.id);
      case "fast":
        return game.setFast(pid, msg.on);
      case "sync":
        return game.sync(pid);
    }
  }
}
