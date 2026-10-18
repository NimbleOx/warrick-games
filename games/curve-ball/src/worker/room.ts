import { mulberry32, randomSeed } from "@warrick/kit/shared/rng";
import type { GameIO } from "@warrick/kit/worker/lobby";
import { Room } from "@warrick/kit/worker/room";
import { RESYNC_EVERY_MS, TICK_MS } from "../shared/constants";
import type { ClientMsg, GameState, ServerMsg } from "../shared/protocol";
import { Game, newGameState, snapshot, type Live } from "./game";

/**
 * One Durable Object per game code (the kit's Room does sockets, storage and cleanup). The
 * countdown and the pause between rounds run off its alarm. While a round is being played, the
 * tick loop steps it 30 times a second and broadcasts each tick. The loop keeps the object
 * awake, so it stops when the round ends or nobody is connected, letting idle games hibernate.
 */
export class GameRoom extends Room<GameState, Game, Live> {
  protected readonly tickMs = TICK_MS;
  private rng = mulberry32(randomSeed());
  /** When each socket was last sent a snapshot for a resync. */
  private resyncAt = new WeakMap<WebSocket, number>();

  protected newState(code: string, now: number): GameState {
    return newGameState(code, now);
  }

  protected makeGame(state: GameState, io: GameIO, live: Live | null): Game {
    return new Game(state, io, live, this.rng);
  }

  protected timerAt(state: GameState): number | null {
    return state.timer?.at ?? null;
  }

  protected wantsLoop(state: GameState): boolean {
    return state.phase === "playing" && !!this.live;
  }

  /**
   * A round that stopped ticking (nobody else was here, or the room restarted) picks back up.
   * One that's still ticking for the others carries on.
   */
  protected afterHello(game: Game): void {
    if (!this.looping) game.recover();
  }

  protected welcome(game: Game): object {
    return { round: game.live ? snapshot(game.live) : null };
  }

  protected handle(ws: WebSocket, game: Game, pid: string, raw: { t: string }): void {
    const msg = raw as ClientMsg;
    if (msg.t === "steer") {
      game.steer(pid, msg.s);
    } else if (msg.t === "resync") {
      this.resync(ws, game);
    }
  }

  /**
   * Send a fresh snapshot to a client that lost track of the round. It holds the whole input log
   * and is encoded on the same thread as the tick, so each socket gets one per RESYNC_EVERY_MS at
   * most. The rest are dropped; a client still waiting asks again.
   */
  private resync(ws: WebSocket, game: Game): void {
    if (!game.live) return;
    const now = Date.now();
    const last = this.resyncAt.get(ws);
    if (last !== undefined && now - last < RESYNC_EVERY_MS) return;
    this.resyncAt.set(ws, now);
    send(ws, { t: "round", round: snapshot(game.live) });
  }
}

function send(ws: WebSocket, msg: ServerMsg): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Ignore sends to sockets that are closing.
  }
}
