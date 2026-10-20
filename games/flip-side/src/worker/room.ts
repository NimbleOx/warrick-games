import { mulberry32, randomSeed } from "@warrick/kit/shared/rng";
import type { GameIO } from "@warrick/kit/worker/lobby";
import { Room } from "@warrick/kit/worker/room";
import { FRAME_MS } from "../shared/constants";
import type { ClientMsg, GameState } from "../shared/protocol";
import { Game, newGameState } from "./game";
import type { Match } from "./match";

/**
 * One Durable Object per game code (the kit's Room does sockets, storage and cleanup). While a
 * match is played and someone is connected, the tick loop steps every table and sends a frame;
 * the countdown runs off the alarm. The match (the kit's `live`) changes 120 times a second, far
 * too often to save, so it lives in memory only.
 */
export class GameRoom extends Room<GameState, Game, Match> {
  protected readonly tickMs = FRAME_MS;
  private rng = mulberry32(randomSeed());

  protected newState(code: string, now: number): GameState {
    return newGameState(code, now);
  }

  protected makeGame(state: GameState, io: GameIO, live: Match | null): Game {
    return new Game(state, io, live, this.rng);
  }

  protected timerAt(state: GameState): number | null {
    return state.timer?.at ?? null;
  }

  protected wantsLoop(state: GameState): boolean {
    return state.phase === "playing" && !!this.live;
  }

  /** A match that stopped stepping (everyone had gone, or the room restarted) picks back up. */
  protected afterHello(game: Game): void {
    if (!this.looping) game.recover();
  }

  protected welcome(game: Game): object {
    return { match: game.match?.snapshot() ?? null };
  }

  protected handle(_ws: WebSocket, game: Game, pid: string, raw: { t: string }): void {
    const msg = raw as ClientMsg;
    if (msg.t === "play") game.play(pid, msg);
    else if (msg.t === "resync") game.resync(pid, msg.run);
  }
}
