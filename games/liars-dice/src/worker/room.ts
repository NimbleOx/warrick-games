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
 * dice can't go in the state (every socket gets the state), so this room keeps them under their
 * own key, written in the same write as the state whenever they changed. A deploy mid-round then
 * resumes with the same dice.
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

  protected changedKeys(): Record<string, unknown> | null {
    // The game replaces the hands whenever they change, so a new object means new dice.
    if (this.live === this.savedHands) return null;
    this.savedHands = this.live;
    return { [HANDS_KEY]: this.live };
  }
}
