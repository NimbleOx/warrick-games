import type { GameIO } from "@warrick/kit/worker/lobby";
import { Room } from "@warrick/kit/worker/room";
import { TICK_MS } from "../shared/constants";
import type { Cmd } from "../shared/battle";
import type { ClientMsg, GameState } from "../shared/protocol";
import { Game, newGameState, restore, type Live, type SavedRound } from "./game";

/**
 * One Durable Object per game code (the kit's Room does sockets, storage and cleanup). While the
 * battle runs and someone is connected, the tick loop steps it and broadcasts a frame every tick:
 * all round long in real time, and while each turn plays out in turns. The loop stops when the
 * round ends, while players plan, or when everyone leaves, so idle games can hibernate. The
 * alarm ends a turn's time to plan.
 *
 * The battle lives in memory. In turns, the room also saves the battle as each turn's planning
 * begins ("saved") and the plans as they change ("plans"). Nothing keeps the object awake while
 * everyone plans, so it may hibernate then, and every deploy restarts it: either way, the next
 * event finds the round gone and brings it back from those (`restore`).
 */
export class GameRoom extends Room<GameState, Game, Live> {
  protected readonly tickMs = TICK_MS;
  /** What's in storage under "saved" and "plans" (and the plans as JSON, to spot a change). */
  private saved: SavedRound | null = null;
  private plans: Cmd[][] | null = null;
  private plansJson = "null";

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<unknown>(["saved", "plans"]);
      this.saved = (stored.get("saved") as SavedRound | null | undefined) ?? null;
      this.plans = (stored.get("plans") as Cmd[][] | null | undefined) ?? null;
      this.plansJson = JSON.stringify(this.plans);
    });
  }

  protected newState(code: string, now: number): GameState {
    return newGameState(code, now);
  }

  protected makeGame(state: GameState, io: GameIO, live: Live | null): Game {
    return new Game(state, io, live ?? restore(state, this.saved, this.plans));
  }

  protected wantsLoop(state: GameState): boolean {
    return state.phase === "playing" && !!this.live && (!state.turn || state.turn.stage === "run");
  }

  protected timerAt(state: GameState): number | null {
    return state.phase === "playing" && state.turn?.stage === "plan" ? state.turn.deadline : null;
  }

  /** A round lost with nothing saved starts over; a player planning gets their plan back. */
  protected afterHello(game: Game, pid: string): void {
    game.greet(pid);
  }

  /**
   * Turns: save the battle as each turn's planning begins, and the plans whenever they change
   * while everyone plans (the run's orders are the plans as planning ended). Forget them once the
   * round is over.
   */
  protected changedKeys(): Record<string, unknown> | null {
    const s = this.state;
    const live = this.live;
    if (s?.phase !== "playing") {
      if (!this.saved && !this.plans) return null;
      this.saved = this.plans = null;
      this.plansJson = "null";
      return { saved: null, plans: null };
    }
    if (s.turn?.stage !== "plan" || !live) return null;
    const keys: Record<string, unknown> = {};
    if (this.saved?.round !== s.round || this.saved.turn !== s.turn.n) {
      this.saved = keys.saved = { round: s.round, turn: s.turn.n, snap: live.battle.snapshot() };
    }
    const json = JSON.stringify(live.plans);
    if (json !== this.plansJson) {
      this.plansJson = json;
      this.plans = keys.plans = JSON.parse(json) as Cmd[][];
    }
    return keys.saved || keys.plans ? keys : null;
  }

  protected welcome(game: Game): object {
    // The welcome carries the battle; don't send it twice.
    game.outbox = game.outbox.filter((m) => m.t !== "snap");
    return { snap: game.snapshot() };
  }

  protected handle(ws: WebSocket, game: Game, pid: string, raw: { t: string }): void {
    const msg = raw as ClientMsg;
    switch (msg.t) {
      case "send":
        return game.send(pid, msg.from, msg.to, msg.pct);
      case "up":
        return game.upgrade(pid, msg.b);
      case "undo":
        return game.undo(pid);
      case "done":
        return game.done(pid, msg.done);
      case "resync": {
        const snap = game.snapshot();
        if (snap) ws.send(JSON.stringify({ t: "snap", snap }));
        return;
      }
    }
  }
}
