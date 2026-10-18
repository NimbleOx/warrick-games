import { MAX_PLAYERS } from "@warrick/kit/shared/constants";
import type { BasePlayer } from "@warrick/kit/shared/protocol";
import { mulberry32, randomSeed } from "@warrick/kit/shared/rng";
import { Lobby, baseState } from "@warrick/kit/worker/lobby";
import { COUNTDOWN_MS } from "../shared/constants";
import {
  DEFAULT_SETTINGS,
  SETTING_CHOICES,
  type GameState,
  type PlayerState,
  type RoundResult,
  type RoundSnap,
  type ServerMsg,
  type Standing,
} from "../shared/protocol";
import { Round, type MoveMsg } from "./round";

export { GameError, type GameIO } from "@warrick/kit/worker/lobby";

/** The round being played. It changes with every move, so it lives in memory only. */
export interface Live {
  round: Round;
}

export function newGameState(code: string, now: number): GameState {
  return { ...baseState(code, now, DEFAULT_SETTINGS), round: 0, results: null };
}

/**
 * Double Trouble's rules on top of the kit's lobby: starting rounds, replaying players' moves,
 * the tick (CPUs, idle players) and the results.
 */
export class Game extends Lobby<GameState, ServerMsg, Live> {
  protected readonly choices = SETTING_CHOICES;

  protected createPlayer(base: BasePlayer): PlayerState {
    return { ...base, slot: -1, wins: 0 };
  }

  /** A player left mid-round: they're out, and that can end the round. */
  leave(id: string): void {
    const p = this.player(id);
    if (p && p.slot >= 0 && this.live) {
      this.live.round.leave(p.slot, this.io.now());
      this.drain();
    }
    super.leave(id);
    if (this.live?.round.over) this.finish();
  }

  /** Start a round, from the lobby or from the last round's results. */
  start(byId: string): void {
    this.beginStart(byId);
    this.s.round++;
    this.participants.forEach((p, i) => (p.slot = i));
    this.startRound();
    const { goal } = this.s.settings;
    const n = this.participants.length;
    this.event(`Round ${this.s.round}: ${n} players. ${goal ? `First to ${goal} wins!` : "Last one standing wins!"}`);
  }

  protected resetForLobby(): void {
    this.s.results = null;
  }

  /** The room restarted mid-round and the boards were lost: play the round again. */
  recover(): void {
    if (this.s.phase !== "playing" || this.live) return;
    this.event(`The server restarted, so round ${this.s.round} starts over`);
    this.startRound();
  }

  move(id: string, m: MoveMsg): void {
    const p = this.player(id);
    if (!p || p.slot < 0 || !this.live) return;
    this.live.round.move(p.slot, m, this.io.now());
    this.drain();
    if (this.live.round.over) this.finish();
  }

  snapshot(): RoundSnap | null {
    const live = this.live;
    if (!live) return null;
    const who = Array<string | null>(MAX_PLAYERS).fill(null);
    for (const p of this.s.players) if (p.slot >= 0) who[p.slot] = p.id;
    return live.round.snapshot(this.s.round, who);
  }

  /** CPU moves and idle players; called on the room's tick. */
  tick(): void {
    const live = this.live;
    if (!live || this.s.phase !== "playing") return;
    live.round.tick(this.io.now());
    this.drain();
    if (live.round.over) this.finish();
  }

  /** Queue the round's ops as one frame, and any corrections for the players they concern. */
  private drain(): void {
    const round = this.live?.round;
    if (!round) return;
    if (round.ops.length) {
      this.outbox.push({ t: "f", o: round.ops });
      round.ops = [];
    }
    for (const slot of round.fixes) {
      const p = this.s.players.find((o) => o.slot === slot);
      const seat = round.seat(slot);
      if (p && seat) this.direct.push({ pid: p.id, msg: { t: "fix", s: slot, seat: round.seatSnap(seat) } });
    }
    round.fixes.clear();
  }

  private startRound(): void {
    const s = this.s;
    const seated = this.participants.filter((p) => p.slot >= 0);
    const round = new Round({
      seed: randomSeed(),
      goAt: this.io.now() + COUNTDOWN_MS,
      size: s.settings.size,
      goal: s.settings.goal,
      aim: s.settings.aim,
      slots: seated.map((p) => ({ slot: p.slot, cpu: p.cpu })),
      rng: mulberry32(randomSeed()),
    });
    this.live = { round };
    s.phase = "playing";
    s.results = null;
    this.outbox.push({ t: "snap", snap: this.snapshot()!, now: this.io.now() });
    this.touch();
  }

  private finish(): void {
    const s = this.s;
    const round = this.live!.round;
    const now = this.io.now();
    const standings: Standing[] = [];
    for (const p of this.s.players) {
      const seat = p.slot >= 0 ? round.seat(p.slot) : null;
      if (!seat) continue;
      const lane = seat.lane;
      standings.push({
        id: p.id,
        name: p.name,
        color: p.color,
        cpu: !!p.cpu,
        place: seat.place || 1,
        best: lane.best,
        score: lane.score,
        sent: seat.atk,
        smashed: lane.smashed,
        kos: seat.kos,
        moves: lane.n,
        secs: Math.round(round.survived(p.slot, now)),
      });
    }
    standings.sort((a, b) => a.place - b.place || b.best - a.best || b.score - a.score);
    const winner = standings.find((x) => x.place === 1) ?? null;
    const result: RoundResult = { round: s.round, winnerId: winner?.id ?? null, how: round.how, goal: round.goal, standings };
    s.results = result;
    s.phase = "results";
    for (const p of s.players) p.slot = -1;
    if (winner) {
      this.player(winner.id)!.wins++;
      this.event(
        round.how === "goal" ? `${winner.name} made ${round.goal} and wins round ${s.round}!` : `${winner.name} wins round ${s.round}!`,
      );
    } else {
      this.event(`Round ${s.round} is over.`);
    }
    this.live = null;
    this.touch();
  }
}
