import type { GameIO } from "@warrick/kit/worker/lobby";
import { Room } from "@warrick/kit/worker/room";
import type { HexMap } from "../shared/map";
import type { ClientMsg, GameState, WelcomeExtra } from "../shared/protocol";
import { Game, newGameState } from "./game";

const MAP_KEY = "map";

/**
 * One Durable Object per game code (the kit's Room does sockets, storage and cleanup). The
 * turn clock, the CPUs' attacks, the end-of-turn dice drop and the winner's banner all run
 * off its alarm, so between actions the room can hibernate.
 *
 * The map is the room's `live` state. It's about 8 KB and never changes during a game, so it
 * isn't in the state, which is saved after every attack: it has its own key, written only when
 * a game makes a new map (and cleared back in the lobby).
 */
export class GameRoom extends Room<GameState, Game, HexMap> {
  /** The map as last saved, so it's only written when it changes. */
  private savedMap: HexMap | null = null;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.live = (await ctx.storage.get<HexMap>(MAP_KEY)) ?? null;
      this.savedMap = this.live;
    });
  }

  protected newState(code: string, now: number): GameState {
    return newGameState(code, now);
  }

  protected makeGame(state: GameState, io: GameIO): Game {
    // A game saved before the map had its own key: it moves there, and the next save writes it.
    const old = state as GameState & { map?: HexMap | null };
    if (old.map !== undefined) {
      this.live = old.map ?? this.live;
      delete old.map;
    }
    return new Game(state, io, this.live);
  }

  protected changedKeys(): Record<string, unknown> | null {
    if (this.live === this.savedMap) return null;
    this.savedMap = this.live;
    return { [MAP_KEY]: this.live };
  }

  protected welcome(game: Game): WelcomeExtra {
    return { map: game.live };
  }

  protected timerAt(state: GameState): number | null {
    return state.timer?.at ?? null;
  }

  protected handle(_ws: WebSocket, game: Game, pid: string, raw: { t: string }): void {
    const msg = raw as ClientMsg;
    switch (msg.t) {
      case "attack":
        return game.attack(pid, msg.from, msg.to);
      case "end":
        return game.endTurn(pid);
      case "takeover":
        return game.takeover(pid, msg.id);
      case "fast":
        return game.setFast(pid, msg.on);
      case "sync":
        return game.sync(pid);
    }
  }
}
