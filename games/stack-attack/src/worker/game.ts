import { MAX_PLAYERS } from "@warrick/kit/shared/constants";
import type { BasePlayer } from "@warrick/kit/shared/protocol";
import { mulberry32, randomSeed } from "@warrick/kit/shared/rng";
import { Lobby, baseState } from "@warrick/kit/worker/lobby";
import { COUNTDOWN_MS, PLAYER_COLORS } from "../shared/constants";
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
import { Round, type LockMsg } from "./round";

export { GameError, type GameIO } from "@warrick/kit/worker/lobby";

/** The round being played. It changes with every piece, so it lives in memory only. */
export interface Live {
  round: Round;
}

export function newGameState(code: string, now: number): GameState {
  return { ...baseState(code, now, DEFAULT_SETTINGS), round: 0, results: null };
}

/**
 * Stack Attack's rules on top of the kit's lobby: starting rounds, replaying players' locks,
 * the tick (CPUs, autopilot, hanging pieces) and the results.
 */
export class Game extends Lobby<GameState, ServerMsg, Live> {
  protected readonly choices = SETTING_CHOICES;
  protected readonly colors = PLAYER_COLORS;

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

  /** Start a round, from the lobby or from the last round's results. One player on their own plays solo. */
  start(byId: string): void {
    this.beginStart(byId, 1);
    this.s.round++;
    this.participants.forEach((p, i) => (p.slot = i));
    this.startRound();
    const n = this.participants.length;
    this.event(
      n === 1
        ? `Round ${this.s.round}: solo. Play until you top out!`
        : `Round ${this.s.round}: ${n} players. Last one standing wins!`,
    );
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

  lock(id: string, m: LockMsg): void {
    const p = this.player(id);
    if (!p || p.slot < 0 || !this.live) return;
    this.live.round.lock(p.slot, m, this.io.now());
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

  /** CPU moves, autopilot and hanging pieces; called on the room's tick. */
  tick(): void {
    const live = this.live;
    if (!live || this.s.phase !== "playing") return;
    const bySlot = new Map(this.s.players.filter((p) => p.slot >= 0).map((p) => [p.slot, p]));
    live.round.tick(this.io.now(), (slot) => {
      const p = bySlot.get(slot);
      return !p || !this.io.isConnected(p.id);
    });
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
    const rng = mulberry32(randomSeed());
    const seated = this.participants.filter((p) => p.slot >= 0);
    const round = new Round({
      seed: randomSeed(),
      goAt: this.io.now() + COUNTDOWN_MS,
      speed: s.settings.speed,
      aim: s.settings.aim,
      slots: seated.map((p) => ({ slot: p.slot, cpu: p.cpu })),
      rng,
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
      standings.push({
        id: p.id,
        name: p.name,
        color: p.color,
        cpu: !!p.cpu,
        place: seat.place || 1,
        kos: seat.kos,
        sent: seat.atk,
        lines: seat.lane.lines,
        pieces: seat.lane.pc,
        score: seat.score,
        level: round.reached(p.slot, now),
        secs: Math.round(round.survived(p.slot, now)),
      });
    }
    standings.sort((a, b) => a.place - b.place || b.kos - a.kos);
    const solo = round.solo;
    const winner = solo ? null : (standings.find((x) => x.place === 1) ?? null);
    const result: RoundResult = { round: s.round, winnerId: winner?.id ?? null, solo, standings };
    s.results = result;
    s.phase = "results";
    for (const p of s.players) p.slot = -1;
    const me = solo ? standings[0] : null;
    if (me) {
      this.event(`${me.name} topped out with ${me.score.toLocaleString("en")} points: ${me.lines} lines, level ${me.level}`);
    } else if (winner) {
      this.player(winner.id)!.wins++;
      this.event(`${winner.name} wins round ${s.round}!`);
    } else {
      this.event(`Round ${s.round} is over.`);
    }
    this.live = null;
    this.touch();
  }
}
