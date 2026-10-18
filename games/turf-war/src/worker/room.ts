import type { GameIO } from "@warrick/kit/worker/lobby";
import { Room } from "@warrick/kit/worker/room";
import { RESYNC_MS, TICK_MS } from "../shared/constants";
import type { ClientMsg, GameState } from "../shared/protocol";
import { Game, newGameState, type Live } from "./game";

/**
 * One Durable Object per game code (the kit's Room does sockets, storage and cleanup). While a
 * round is on and someone is connected, the tick loop steps the board and broadcasts every tick.
 * The loop keeps the object awake; it stops when the round ends or everyone leaves, so idle
 * games can hibernate. The round's board lives in memory only: it changes every tick, far too
 * often to persist.
 */
export class GameRoom extends Room<GameState, Game, Live> {
  protected readonly tickMs = TICK_MS;
  /** When each socket was last sent a snapshot it asked for. */
  private lastResync = new WeakMap<WebSocket, number>();

  protected newState(code: string, now: number): GameState {
    return newGameState(code, now);
  }

  protected makeGame(state: GameState, io: GameIO, live: Live | null): Game {
    return new Game(state, io, live);
  }

  protected wantsLoop(state: GameState): boolean {
    return state.phase === "playing" && !!this.live;
  }

  /** A round whose board was lost (the object restarted) starts over. */
  protected afterHello(game: Game): void {
    game.recover();
  }

  protected welcome(game: Game): object {
    // The welcome carries the board; don't send it twice.
    game.outbox = game.outbox.filter((m) => m.t !== "snap");
    return { snap: game.snapshot() };
  }

  protected handle(ws: WebSocket, game: Game, pid: string, raw: { t: string }): void {
    const msg = raw as ClientMsg;
    if (msg.t === "dir") {
      game.turn(pid, msg.d);
    } else if (msg.t === "resync") {
      // A snapshot is a few hundred times the size of the request, so each socket gets one a
      // second at most. The client asks again on its next tick gap or bad checksum.
      const now = Date.now();
      if (now - (this.lastResync.get(ws) ?? -Infinity) < RESYNC_MS) return;
      const snap = game.snapshot();
      if (!snap) return;
      this.lastResync.set(ws, now);
      ws.send(JSON.stringify({ t: "snap", snap }));
    }
  }
}
