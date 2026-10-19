import type { GameIO } from "@warrick/kit/worker/lobby";
import { Room } from "@warrick/kit/worker/room";
import { TICK_MS } from "../shared/constants";
import type { ClientMsg, GameState } from "../shared/protocol";
import { Game, newGameState, type Live } from "./game";

/** A whole frame is about eight times a delta, so each socket gets one a second at most. */
const SYNC_MS = 1000;

/**
 * One Durable Object per game code (the kit's Room does sockets, storage and cleanup). While a
 * round is on and someone is connected, the tick loop runs the arena and broadcasts a frame every
 * tick; between rounds the loop stops, the object can sleep, and the alarm brings on the next round.
 */
export class GameRoom extends Room<GameState, Game, Live> {
  protected readonly tickMs = TICK_MS;
  /**
   * Sockets whose page has said it takes ticks as deltas. A page from before deltas can't, so
   * while one is open (or a socket hasn't said yet), ticks go out whole.
   */
  private deltaSockets = new WeakSet<WebSocket>();
  /** When each socket was last sent the whole arena for a `sync`. */
  private lastSync = new WeakMap<WebSocket, number>();

  protected newState(code: string, now: number): GameState {
    return newGameState(code, now);
  }

  protected makeGame(state: GameState, io: GameIO, live: Live | null): Game {
    return new Game(state, io, live, () => this.allTakeDeltas());
  }

  private allTakeDeltas(): boolean {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState === WebSocket.OPEN && !this.deltaSockets.has(ws)) return false;
    }
    return true;
  }

  protected wantsLoop(state: GameState): boolean {
    return state.phase === "playing" && !!this.live;
  }

  protected timerAt(state: GameState): number | null {
    return state.timer?.at ?? null;
  }

  /** A round whose arena was lost (the object restarted) is dealt again. */
  protected afterHello(game: Game): void {
    game.restartRound();
  }

  protected welcome(game: Game): object {
    return { frame: game.live?.arena.catchUp() ?? null };
  }

  protected handle(ws: WebSocket, game: Game, pid: string, raw: { t: string }): void {
    const msg = raw as ClientMsg;
    if (msg.t === "move" || msg.t === "bomb") game.move(pid, msg.x, msg.y, msg.d, msg.t === "bomb");
    else if (msg.t === "deltas") this.deltaSockets.add(ws);
    else if (msg.t === "sync") {
      // The page asks again if it hears nothing back (see the client's `onDelta`).
      const now = Date.now();
      if (now - (this.lastSync.get(ws) ?? -Infinity) < SYNC_MS) return;
      this.lastSync.set(ws, now);
      game.sync(pid);
    }
  }
}
