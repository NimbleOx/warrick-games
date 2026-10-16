import { mulberry32, randomSeed } from "@warrick/kit/shared/rng";
import type { GameIO } from "@warrick/kit/worker/lobby";
import { Room } from "@warrick/kit/worker/room";
import type { Arena } from "../shared/arena";
import { tickMsFor } from "../shared/constants";
import { DEFAULT_SETTINGS, type ClientMsg, type GameState } from "../shared/protocol";
import { Game, newGameState } from "./game";

/**
 * One Durable Object per game code (the kit's Room does sockets, storage and cleanup). While a
 * round is being ridden and someone is connected, the tick loop steps the arena and broadcasts
 * every tick; the countdown and the pause after each round run off the alarm. The arena (the
 * kit's `live`) changes every tick, far too often to persist, so it lives in memory only.
 */
export class GameRoom extends Room<GameState, Game, Arena> {
  /** Follows the speed setting: see `wantsLoop`. */
  protected tickMs = tickMsFor(DEFAULT_SETTINGS.speed);
  private rng = mulberry32(randomSeed());

  protected newState(code: string, now: number): GameState {
    return newGameState(code, now);
  }

  protected makeGame(state: GameState, io: GameIO, live: Arena | null): Game {
    return new Game(state, io, live, this.rng);
  }

  protected timerAt(state: GameState): number | null {
    return state.timer?.at ?? null;
  }

  protected wantsLoop(state: GameState): boolean {
    // The kit asks this just before it schedules a tick, so the loop runs at the round's speed.
    this.tickMs = tickMsFor(state.settings.speed);
    return state.phase === "playing" && !!this.live;
  }

  /** A round that stopped ticking (everyone had gone, or the room restarted) picks back up. */
  protected afterHello(game: Game): void {
    if (!this.looping) game.recover();
  }

  protected welcome(game: Game): object {
    return { arena: game.arena?.snapshot() ?? null };
  }

  protected handle(_ws: WebSocket, game: Game, pid: string, raw: { t: string }): void {
    const msg = raw as ClientMsg;
    if (msg.t === "turn") game.turn(pid, msg.dir, msg.at);
    else if (msg.t === "boost") game.boost(pid, msg.at);
  }
}
