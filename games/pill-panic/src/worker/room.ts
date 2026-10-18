import type { GameIO } from "@warrick/kit/worker/lobby";
import { Room } from "@warrick/kit/worker/room";
import { LOOP_MS } from "../shared/constants";
import type { ClientMsg, GameState } from "../shared/protocol";
import { Game, newGameState, type Live } from "./game";

/** Inputs can run long: a tab waking from sleep catches up hundreds of ticks at once. */
const MAX_MSG_BYTES = 8192;

/**
 * One Durable Object per game code (the kit's Room does sockets, storage and cleanup). While a
 * match is on and someone is connected, the loop steps the CPU bottles and broadcasts what every
 * bottle did. Players' inputs are handled here, as they arrive.
 */
export class GameRoom extends Room<GameState, Game, Live> {
  protected readonly tickMs = LOOP_MS;

  protected newState(code: string, now: number): GameState {
    return newGameState(code, now);
  }

  protected makeGame(state: GameState, io: GameIO, live: Live | null): Game {
    return new Game(state, io, live);
  }

  protected wantsLoop(state: GameState): boolean {
    return state.phase === "playing";
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const msg = this.state && typeof raw === "string" && raw.length <= MAX_MSG_BYTES ? parse(raw) : null;
    // Inputs are the busiest message by far, and can be longer than the kit takes. They only
    // feed the round; the loop broadcasts.
    if (msg?.t === "in") {
      const pid = playerOf(ws);
      if (pid) this.makeGame(this.state!, this.io(), this.live).feed(pid, msg);
      return;
    }
    return super.webSocketMessage(ws, raw);
  }

  protected afterHello(game: Game, pid: string): void {
    // A round whose bottles were lost (the object restarted) starts over.
    game.recover();
    // The browser starts its own bottle over from ours.
    game.rejoin(pid);
    // The loop stops while nobody is here. The first one back picks the round up where it stopped.
    if (!this.looping) game.resume();
  }

  protected welcome(game: Game): object {
    // The welcome carries the bottles; don't send them twice.
    game.outbox = game.outbox.filter((m) => m.t !== "snap");
    return { snap: game.snapshot() };
  }

  protected handle(ws: WebSocket, game: Game, pid: string, raw: { t: string }): void {
    const msg = raw as ClientMsg;
    if (msg.t !== "resync") return;
    if (msg.own) return game.resyncOwn(pid);
    const snap = game.snapshot();
    if (snap) send(ws, { t: "snap", snap });
  }

  private io(): GameIO {
    return { now: () => Date.now(), isConnected: (id) => this.connectedIds().has(id) };
  }
}

function parse(raw: string): ClientMsg | null {
  try {
    return JSON.parse(raw) as ClientMsg | null;
  } catch {
    return null;
  }
}

function playerOf(ws: WebSocket): string | null {
  return (ws.deserializeAttachment() as { pid: string | null } | null)?.pid ?? null;
}

function send(ws: WebSocket, msg: object): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Ignore sends to sockets that are closing.
  }
}
