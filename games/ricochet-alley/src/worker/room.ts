import type { GameIO } from "@warrick/kit/worker/lobby";
import { Room } from "@warrick/kit/worker/room";
import { TICK_MS } from "../shared/constants";
import type { ClientMsg, GameState } from "../shared/protocol";
import { Game, newGameState, type Live } from "./game";

/** Messages a socket may send per second before the rest are dropped (input changes are the busy ones). */
const MAX_MSGS_PER_SEC = 90;

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
  private rates = new WeakMap<WebSocket, { at: number; n: number }>();
  /**
   * Each socket's player id, cached: the tick loop asks for every socket several times a frame, and
   * attachments are slow to read. A socket only gets a player by saying hello (see afterHello); leaving or
   * being kicked closes it, and closed sockets are skipped anyway.
   */
  private pids = new WeakMap<WebSocket, string | null>();
  /** The socket whose message is being handled, while its handling runs up to the first await. */
  private speaking: WebSocket | null = null;

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

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (this.overLimit(ws)) return;
    this.speaking = ws;
    const done = super.webSocketMessage(ws, raw);
    this.speaking = null;
    await done;
  }

  /** Pick a stalled round back up: rebuild it after a restart, or resume it if it paused with nobody here. */
  protected afterHello(game: Game): void {
    if (this.speaking) this.pids.delete(this.speaking);
    game.wake(this.loopRunning());
  }

  /** A round in progress is sent with the welcome, for a player arriving or coming back. */
  protected welcome(game: Game): object {
    return { world: game.live.round?.world.snapshot() ?? null };
  }

  protected handle(_ws: WebSocket, game: Game, pid: string, raw: { t: string }): void {
    const msg = raw as ClientMsg;
    if (msg.t === "in") game.input(pid, msg.s, msg.b, msg.f === 1);
  }

  protected connectedIds(except?: WebSocket): Set<string> {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
      const pid = this.pidOf(ws);
      if (pid) ids.add(pid);
    }
    return ids;
  }

  protected broadcast(msg: object): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN || !this.pidOf(ws)) continue;
      try {
        ws.send(data);
      } catch {
        // Socket is going away; webSocketClose will clean up.
      }
    }
  }

  /**
   * The kit runs the loop while a round is live and someone is connected. Whoever is saying hello has only
   * just arrived, so it's running if anyone else is here.
   */
  private loopRunning(): boolean {
    return !!this.state && this.wantsLoop(this.state) && this.connectedIds(this.speaking ?? undefined).size > 0;
  }

  private pidOf(ws: WebSocket): string | null {
    let pid = this.pids.get(ws);
    if (pid === undefined) {
      pid = (ws.deserializeAttachment() as { pid: string | null } | null)?.pid ?? null;
      this.pids.set(ws, pid);
    }
    return pid;
  }

  private overLimit(ws: WebSocket): boolean {
    const now = Date.now();
    const r = this.rates.get(ws);
    if (!r || now - r.at >= 1000) {
      this.rates.set(ws, { at: now, n: 1 });
      return false;
    }
    return ++r.n > MAX_MSGS_PER_SEC;
  }
}
