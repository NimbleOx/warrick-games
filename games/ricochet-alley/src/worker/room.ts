import type { GameIO } from "@warrick/kit/worker/lobby";
import { Room } from "@warrick/kit/worker/room";
import { TICK_MS } from "../shared/constants";
import type { ClientMsg, GameState } from "../shared/protocol";
import { Game, newGameState, type Live } from "./game";

/**
 * One Durable Object per game code (the kit's Room does sockets, storage and cleanup). During a round the
 * 30 Hz tick loop steps the simulation and broadcasts a frame every tick; between rounds the loop stops,
 * and the countdown and the round-over pause run off the alarm, so an idle game can hibernate.
 *
 * The round itself (tank positions, bullets) lives only in memory; after a restart the round begins again
 * from its saved starting positions.
 */
export class GameRoom extends Room<GameState, Game, Live> {
  protected readonly tickMs = TICK_MS;

  protected newState(code: string, now: number): GameState {
    return newGameState(code, now);
  }

  protected makeGame(state: GameState, io: GameIO, live: Live | null): Game {
    return new Game(state, io, live);
  }

  protected timerAt(state: GameState): number | null {
    return state.timer?.at ?? null;
  }

  protected wantsLoop(state: GameState): boolean {
    return state.phase === "playing" && !!this.live?.round;
  }

  /** Pick a stalled round back up: rebuild it after a restart, or resume it if it paused with nobody here. */
  protected afterHello(game: Game): void {
    game.wake(this.looping);
  }

  /** A round in progress is sent with the welcome, for a player arriving or coming back. */
  protected welcome(game: Game): object {
    return { world: game.live.round?.world.snapshot() ?? null };
  }

  protected handle(_ws: WebSocket, game: Game, pid: string, raw: { t: string }): void {
    const msg = raw as ClientMsg;
    if (msg.t === "in") game.input(pid, msg.s, msg.b, msg.f === 1);
  }
}
