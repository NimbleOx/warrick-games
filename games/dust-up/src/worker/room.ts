import { mulberry32, randomSeed } from "@warrick/kit/shared/rng";
import type { GameIO } from "@warrick/kit/worker/lobby";
import { Room } from "@warrick/kit/worker/room";
import { FRAME_MS } from "../shared/constants";
import type { ClientMsg, GameState } from "../shared/protocol";
import { Game, newGameState } from "./game";
import type { Race } from "./race";

/**
 * One Durable Object per game code (the kit's Room does sockets, storage and cleanup). While a
 * course is being ridden and someone is connected, the tick loop steps every bike and sends a
 * frame; the countdown and the results run off the alarm. The race (the kit's `live`) changes
 * 120 times a second, far too often to save, so it lives in memory only.
 */
export class GameRoom extends Room<GameState, Game, Race> {
  protected readonly tickMs = FRAME_MS;
  private rng = mulberry32(randomSeed());

  protected newState(code: string, now: number): GameState {
    return newGameState(code, now);
  }

  protected makeGame(state: GameState, io: GameIO, live: Race | null): Game {
    return new Game(state, io, live, this.rng);
  }

  protected timerAt(state: GameState): number | null {
    return state.timer?.at ?? null;
  }

  protected wantsLoop(state: GameState): boolean {
    return state.phase === "riding" && !!this.live;
  }

  /** A course that stopped stepping (everyone had gone, or the room restarted) picks back up. */
  protected afterHello(game: Game): void {
    if (!this.looping) game.recover();
  }

  protected welcome(game: Game): object {
    return { race: game.race?.snapshot() ?? null };
  }

  protected handle(_ws: WebSocket, game: Game, pid: string, raw: { t: string }): void {
    const msg = raw as ClientMsg;
    if (msg.t === "ride") game.ride(pid, msg);
    else if (msg.t === "resync") game.resync(pid, msg.run);
    else if (msg.t === "again") game.again(pid);
    else if (msg.t === "next") game.next(pid);
  }
}
