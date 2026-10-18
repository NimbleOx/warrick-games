import type { GameIO } from "@warrick/kit/worker/lobby";
import { Room } from "@warrick/kit/worker/room";
import type { ClientMsg, GameState, Hands } from "../shared/protocol";
import { Game, newGameState } from "./game";

const HANDS_KEY = "hands";

/**
 * One Durable Object per game code (the kit's Room does sockets, storage and cleanup). Turn
 * timers, CPU turns and the reveal after a call all run off its alarm.
 *
 * The current round's dice are the room's `live` state. The kit doesn't save `live`, and the
 * dice can't go in the state (every socket gets the state), so this room saves them under their
 * own key after every message and alarm that changed them. A deploy mid-round then resumes with
 * the same dice.
 */
export class GameRoom extends Room<GameState, Game, Hands> {
  /** The hands as last saved, so they're only written when they change. */
  private savedHands: Hands | null = null;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.live = (await ctx.storage.get<Hands>(HANDS_KEY)) ?? null;
      this.savedHands = this.live;
    });
  }

  protected newState(code: string, now: number): GameState {
    return newGameState(code, now);
  }

  protected makeGame(state: GameState, io: GameIO, live: Hands | null): Game {
    return new Game(state, io, live);
  }

  protected timerAt(state: GameState): number | null {
    return state.timer?.at ?? null;
  }

  protected handle(_ws: WebSocket, game: Game, pid: string, raw: { t: string }): void {
    const msg = raw as ClientMsg;
    switch (msg.t) {
      case "bid":
        return game.bid(pid, msg.qty, msg.face);
      case "liar":
        return game.liar(pid);
      case "spot":
        return game.spot(pid);
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await super.webSocketMessage(ws, raw);
    await this.saveHands();
  }

  async alarm(): Promise<void> {
    await super.alarm();
    await this.saveHands();
  }

  private async saveHands(): Promise<void> {
    // No state: the game was thrown away (its storage with it).
    if (!this.state || this.live === this.savedHands) return;
    this.savedHands = this.live;
    if (this.live) await this.ctx.storage.put(HANDS_KEY, this.live);
    else await this.ctx.storage.delete(HANDS_KEY);
  }
}
