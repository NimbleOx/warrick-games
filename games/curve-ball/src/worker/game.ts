import type { BasePlayer } from "@warrick/kit/shared/protocol";
import { randomSeed, shuffle, type Rng } from "@warrick/kit/shared/rng";
import { GameError, Lobby, baseState, type GameIO } from "@warrick/kit/worker/lobby";
import { cpuSteer } from "../shared/ai";
import { COUNTDOWN_MS, ROUNDOVER_MS, WIN_LEAD } from "../shared/constants";
import {
  CHECKSUM_EVERY,
  DEFAULT_SETTINGS,
  SETTING_CHOICES,
  autoTarget,
  rankPlayers,
  type FrameMsg,
  type GameState,
  type PlayerState,
  type RoundSnapshot,
  type ServerMsg,
} from "../shared/protocol";
import { Round, configFor, isSteer, type Death, type Input, type Steer } from "../shared/sim";

export { GameError, type GameIO } from "@warrick/kit/worker/lobby";

/** The round in progress. Memory only: it changes every tick, far too often to persist. */
export interface Live {
  num: number;
  seed: number;
  round: Round;
  /** Every steering change so far, in order. */
  inputs: Input[];
  /** How many of `inputs` have gone out in frames. */
  sent: number;
}

const CPU_NAMES = ["Bert", "Ziggy", "Moe", "Pixel", "Noodle", "Squiggle", "Loopy", "Zag", "Wobble", "Spud"];
/** Ticks per loop tick once only CPUs are left in a round. */
const FAST_FORWARD = 2;

export function newGameState(code: string, now: number): GameState {
  return {
    ...baseState(code, now, DEFAULT_SETTINGS),
    round: 0,
    target: 0,
    roundWinnerId: null,
    winnerId: null,
    phaseDeadline: null,
    timer: null,
  };
}

export function snapshot(live: Live): RoundSnapshot {
  const { round } = live;
  return {
    num: live.num,
    seed: live.seed,
    ids: round.heads.map((h) => h.id),
    cfg: round.cfg,
    tick: round.tick,
    inputs: live.inputs,
  };
}

/**
 * Curve Ball's rules on top of the kit's lobby: rounds, steering, the tick, scoring and the
 * timers between rounds. The lobby is only open in the "lobby" phase, and a finished match sits
 * in "gameover" until the host takes everyone back.
 */
export class Game extends Lobby<GameState, ServerMsg, Live> {
  protected readonly choices = SETTING_CHOICES;
  protected readonly cpuNames = CPU_NAMES;
  protected readonly finishedPhase = "gameover";

  constructor(
    s: GameState,
    io: GameIO,
    live: Live | null,
    private rng: Rng,
  ) {
    super(s, io, live);
  }

  protected betweenRounds(): boolean {
    return this.s.phase === "lobby";
  }

  protected createPlayer(base: BasePlayer): PlayerState {
    return { ...base, score: 0, wins: 0 };
  }

  // ---------------------------------------------------------------- players

  /** Mid-match, a leaving player keeps their place in the scores. */
  leave(id: string): void {
    const p = this.player(id);
    if (!p) return;
    if (this.s.phase === "lobby" || p.spectator) {
      this.removePlayer(id);
      this.event(`${p.name} left`);
    } else {
      this.event(`${p.name} left the game`);
      this.setConnected(id, false);
    }
  }

  setConnected(id: string, connected: boolean): void {
    super.setConnected(id, connected);
    // Nobody is holding the key any more.
    if (!connected) {
      const slot = this.slotOf(id);
      if (slot >= 0) this.setSteer(slot, 0);
    }
  }

  // ---------------------------------------------------------------- match flow

  start(byId: string): void {
    this.requireHost(byId);
    this.requirePhase("lobby");
    // Players who closed their tab in the lobby don't hold up the game.
    for (const p of [...this.s.players]) {
      if (!p.cpu && !p.connected) this.removePlayer(p.id);
    }
    // Whoever is watching takes a free seat, including one just left by somebody who went.
    this.promoteSpectators();
    if (this.participants.length < 2) throw new GameError("Need at least two players. Add a CPU?");
    for (const p of this.s.players) p.score = p.wins = 0;
    const s = this.s;
    s.round = 0;
    s.winnerId = null;
    s.target = s.settings.target || autoTarget(this.participants.length);
    this.event(`Game on! First to ${s.target} points, with a ${WIN_LEAD}-point lead.`);
    this.startRound();
  }

  protected resetForLobby(): void {
    const s = this.s;
    s.round = 0;
    s.roundWinnerId = null;
    s.winnerId = null;
    s.phaseDeadline = null;
    s.timer = null;
    this.live = null;
  }

  /**
   * Called when players come back to a round that stopped ticking. A round
   * paused with nobody connected resumes after a countdown. The round only
   * lives in memory, so if the room restarted, it starts over; scores are only
   * saved between rounds, so nobody gains or loses points.
   */
  recover(): void {
    const s = this.s;
    if (s.phase !== "countdown" && s.phase !== "playing") return;
    if (!this.live) {
      s.round--;
      this.event(`Round ${s.round + 1} was interrupted. Restarting it.`);
      this.startRound();
    } else if (s.phase === "playing" && this.onlyCpusLeft) {
      // Nobody needs a moment to get ready: the room's tick loop just carries on.
    } else if (s.phase === "playing" || (s.phaseDeadline ?? 0) < this.io.now()) {
      this.event(`Resuming round ${s.round}`);
      this.countdown();
    }
  }

  private startRound(): void {
    const s = this.s;
    s.round++;
    s.roundWinnerId = null;
    // Players who've dropped out sit the round out, unless that would leave too few to play.
    let ids = this.participants.filter((p) => p.cpu || this.io.isConnected(p.id)).map((p) => p.id);
    if (ids.length < 2) ids = this.participants.map((p) => p.id);
    const seed = randomSeed();
    const round = new Round({ cfg: configFor(s.settings.speed), seed, ids: shuffle(this.rng, ids) });
    this.live = { num: s.round, seed, round, inputs: [], sent: 0 };
    this.event(`Round ${s.round}`);
    this.countdown();
  }

  private countdown(): void {
    const s = this.s;
    s.phase = "countdown";
    s.phaseDeadline = this.io.now() + COUNTDOWN_MS;
    s.timer = { kind: "countdown", at: s.phaseDeadline };
    this.outbox.push({ t: "round", round: snapshot(this.live!) });
    this.touch();
  }

  steer(id: string, steer: unknown): void {
    if (!isSteer(steer)) return;
    const slot = this.slotOf(id);
    if (slot >= 0) this.setSteer(slot, steer);
  }

  /** Nobody human is still in the round, so there's no need to watch it in real time. */
  get onlyCpusLeft(): boolean {
    const live = this.live;
    if (!live || this.s.phase !== "playing") return false;
    return live.round.heads.every((h) => !h.alive || !!this.player(h.id)?.cpu);
  }

  /** The room calls this on every tick while the phase is "playing". Once only CPUs are left, it plays at double speed. */
  tick(): void {
    const steps = this.onlyCpusLeft ? FAST_FORWARD : 1;
    for (let i = 0; i < steps; i++) this.step();
  }

  /** One step of the round. */
  private step(): void {
    const live = this.live;
    if (this.s.phase !== "playing" || !live) return;
    const { round } = live;
    round.heads.forEach((h, i) => {
      const cpu = h.alive ? this.player(h.id)?.cpu : null;
      if (!cpu) return;
      const steer = cpuSteer(round, i, cpu, this.rng);
      if (steer !== null) this.setSteer(i, steer);
    });

    const frame: FrameMsg = { t: "f", n: round.tick };
    if (live.sent < live.inputs.length) {
      frame.i = live.inputs.slice(live.sent).map(([, slot, s]) => [slot, s]);
      live.sent = live.inputs.length;
    }
    const deaths = round.step();
    if (deaths.length) frame.d = deaths.map((d) => d.slot);
    if (round.tick % CHECKSUM_EVERY === 0) frame.c = round.checksum();
    this.outbox.push(frame);

    for (const d of deaths) this.announce(d, round);
    if (round.over) this.roundOver();
  }

  private announce(d: Death, round: Round): void {
    const name = (slot: number) => this.player(round.heads[slot].id)?.name ?? "Someone";
    const victim = name(d.slot);
    if (d.headOn) {
      // Both heads report the crash; say it once.
      const other = round.deaths.find((o) => o.slot === d.by && o.tick === d.tick);
      if (d.slot < d.by || !other?.headOn || other.by !== d.slot) {
        this.event(`💥 ${victim} and ${name(d.by)} crashed head-on`);
      }
    } else if (d.by < 0) {
      this.event(`💥 ${victim} hit the wall`);
    } else if (d.by === d.slot) {
      this.event(`💥 ${victim} ran into their own trail`);
    } else {
      this.event(`💥 ${victim} ran into ${name(d.by)}'s trail`);
    }
  }

  private roundOver(): void {
    const s = this.s;
    const { round } = this.live!;
    s.phase = "roundover";
    for (const h of round.heads) {
      const p = this.player(h.id);
      if (p) p.score += h.points;
    }
    const survivor = round.heads.find((h) => h.alive);
    const winner = survivor ? this.player(survivor.id) : undefined;
    if (winner) {
      winner.wins++;
      this.event(`🏆 ${winner.name} wins round ${s.round}`);
    } else {
      this.event(`Round ${s.round}: nobody survived`);
    }
    s.roundWinnerId = winner?.id ?? null;

    const [first, second] = [...this.participants].sort(rankPlayers);
    if (first && first.score >= s.target && first.score - (second?.score ?? 0) >= WIN_LEAD) {
      s.winnerId = first.id;
    } else if (first && first.score >= s.target) {
      this.event(`Match point! ${first.name} needs a ${WIN_LEAD}-point lead to win.`);
    }
    s.phaseDeadline = this.io.now() + ROUNDOVER_MS;
    s.timer = { kind: "roundover", at: s.phaseDeadline };
    this.touch();
  }

  private afterRoundOver(): void {
    const s = this.s;
    const winner = this.player(s.winnerId ?? "");
    if (!winner) return this.startRound();
    s.phase = "gameover";
    s.phaseDeadline = null;
    s.timer = null;
    this.event(`🎉 ${winner.name} wins the match with ${winner.score} points!`);
    this.touch();
  }

  // ---------------------------------------------------------------- timers

  onTimer(): void {
    // The room restarted mid-round and lost it: start it over first.
    if (!this.live) this.recover();
    const s = this.s;
    const t = s.timer;
    if (!t || this.io.now() < t.at - 25) return;
    s.timer = null;
    switch (t.kind) {
      case "countdown":
        if (s.phase === "countdown" && this.live) {
          s.phase = "playing";
          s.phaseDeadline = null;
        }
        break;
      case "roundover":
        if (s.phase === "roundover") this.afterRoundOver();
        break;
    }
    this.touch();
  }

  // ---------------------------------------------------------------- helpers

  private slotOf(id: string): number {
    const { phase } = this.s;
    if (!this.live || (phase !== "countdown" && phase !== "playing")) return -1;
    return this.live.round.index(id);
  }

  /** Steer a head from the next tick on, and log it for the frame and for replays. */
  private setSteer(slot: number, steer: Steer): void {
    const live = this.live!;
    if (!live.round.setSteer(slot, steer)) return;
    const tick = live.round.tick;
    // At most one entry per head per tick: a quick tap and release collapses into the final value.
    for (let k = live.inputs.length - 1; k >= live.sent && live.inputs[k][0] === tick; k--) {
      if (live.inputs[k][1] === slot) {
        live.inputs[k][2] = steer;
        return;
      }
    }
    live.inputs.push([tick, slot, steer]);
  }
}
