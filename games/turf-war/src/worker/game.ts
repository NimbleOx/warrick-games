import { MAX_PLAYERS } from "@warrick/kit/shared/constants";
import type { BasePlayer } from "@warrick/kit/shared/protocol";
import { mulberry32, randomSeed, type Rng } from "@warrick/kit/shared/rng";
import { Lobby, baseState } from "@warrick/kit/worker/lobby";
import { autopilot, newBrain, think, type Brain } from "../shared/ai";
import { isDir } from "../shared/board";
import { PLAYER_COLORS, TICKS_PER_SEC } from "../shared/constants";
import {
  BOARD_SIZES,
  DEFAULT_SETTINGS,
  SETTING_CHOICES,
  percent,
  type GameState,
  type PlayerState,
  type RoundResult,
  type ServerMsg,
  type Snapshot,
  type Standing,
} from "../shared/protocol";
import { Round } from "../shared/sim";

export { GameError, type GameIO } from "@warrick/kit/worker/lobby";

/** The round being played. It changes every tick, so it lives in memory only. */
export interface Live {
  round: Round;
  /** CPU memory, by board slot. */
  brains: (Brain | null)[];
  rng: Rng;
}

export function newGameState(code: string, now: number): GameState {
  return { ...baseState(code, now, DEFAULT_SETTINGS), round: 0, results: null };
}

/**
 * Turf War's rules on top of the kit's lobby: starting rounds, seating players who arrive
 * mid-round, the tick (CPUs, autopilot, the board) and the results.
 */
export class Game extends Lobby<GameState, ServerMsg, Live> {
  protected readonly choices = SETTING_CHOICES;
  protected readonly colors = PLAYER_COLORS;

  protected createPlayer(base: BasePlayer): PlayerState {
    return { ...base, slot: -1, wins: 0 };
  }

  /** A player left mid-round: their head and land come off the board. */
  leave(id: string): void {
    const p = this.player(id);
    if (p && p.slot >= 0) this.live?.round.leave(p.slot);
    super.leave(id);
  }

  /** Start a round, from the lobby or from the last round's results. */
  start(byId: string): void {
    this.beginStart(byId);
    this.s.round++;
    this.participants.forEach((p, i) => (p.slot = i));
    this.startRound();
    const { w, h } = BOARD_SIZES[this.s.settings.board];
    const mins = this.s.settings.roundSeconds / 60;
    this.event(`Round ${this.s.round}: ${mins} minute${mins === 1 ? "" : "s"} on a ${w} × ${h} board. Go!`);
  }

  protected resetForLobby(): void {
    this.s.results = null;
  }

  /** The room restarted mid-round and the board was lost: play the round again. */
  recover(): void {
    if (this.s.phase !== "playing" || this.live) return;
    this.event(`The server restarted, so round ${this.s.round} starts over`);
    this.startRound();
  }

  turn(id: string, d: unknown): void {
    const p = this.player(id);
    if (!p || p.slot < 0 || !this.live || !isDir(d)) return;
    this.live.round.turn(p.slot, d);
  }

  snapshot(): Snapshot | null {
    return this.live?.round.snapshot() ?? null;
  }

  /** Run one tick of the round. */
  tick(): void {
    const live = this.live;
    if (!live || this.s.phase !== "playing") return;
    const { round, brains, rng } = live;
    if (round.playing) {
      for (const p of this.s.players) {
        if (p.slot < 0 || !round.board.heads[p.slot].alive) continue;
        const brain = brains[p.slot];
        if (p.cpu && brain) round.steer(p.slot, think(round, p.slot, brain, rng));
        else if (!p.cpu && !this.io.isConnected(p.id)) round.steer(p.slot, autopilot(round, p.slot, rng));
      }
    }
    this.outbox.push(round.step());
    if (round.over) this.finish();
  }

  private startRound(): void {
    const s = this.s;
    const rng = mulberry32(randomSeed());
    const { w, h } = BOARD_SIZES[s.settings.board];
    const seated = this.participants.filter((p) => p.slot >= 0);
    const round = new Round(rng, {
      w,
      h,
      slots: seated.map((p) => p.slot),
      ticks: s.settings.roundSeconds * TICKS_PER_SEC,
    });
    const brains: (Brain | null)[] = Array(MAX_PLAYERS).fill(null);
    for (const p of seated) if (p.cpu) brains[p.slot] = newBrain(p.cpu);
    this.live = { round, brains, rng };
    s.phase = "playing";
    s.results = null;
    this.outbox.push({ t: "snap", snap: round.snapshot() });
    this.touch();
  }

  private finish(): void {
    const s = this.s;
    const round = this.live!.round;
    const cells = round.board.size;
    const standings: Standing[] = this.participants
      .filter((p) => p.slot >= 0)
      .map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        cpu: !!p.cpu,
        cells: round.board.land[p.slot],
        best: round.best[p.slot],
        kills: round.kills[p.slot],
        deaths: round.deaths[p.slot],
      }))
      .sort((a, b) => b.cells - a.cells || b.kills - a.kills || a.deaths - b.deaths);
    const [first, second] = standings;
    const winner = first && first.cells > 0 && (!second || second.cells < first.cells) ? first : null;
    const result: RoundResult = { round: s.round, cells, winnerId: winner?.id ?? null, standings };
    s.results = result;
    s.phase = "results";
    for (const p of s.players) p.slot = -1;
    if (winner) {
      this.player(winner.id)!.wins++;
      this.event(`${winner.name} wins round ${s.round} with ${percent(winner.cells, cells)} of the board!`);
    } else {
      this.event(`Round ${s.round} is a draw.`);
    }
    this.live = null;
    this.touch();
  }

  /** Give a player joining mid-round a free board slot. Returns false if there isn't one. */
  protected joinMidGame(p: PlayerState): boolean {
    const round = this.live?.round;
    if (!round) return false;
    const taken = new Set(this.s.players.map((o) => o.slot));
    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      if (taken.has(slot) || !round.slotFree(slot)) continue;
      p.slot = slot;
      round.join(slot);
      return true;
    }
    return false;
  }
}
