import type { BasePlayer } from "@warrick/kit/shared/protocol";
import { mulberry32, randInt, randomSeed, shuffle, type Rng } from "@warrick/kit/shared/rng";
import { Lobby, baseState, cleanName, type GameIO } from "@warrick/kit/worker/lobby";
import { steer } from "../shared/ai";
import { Arena, isDir, spawnPoints, type Dir } from "../shared/arena";
import { PLAYER_COLORS, SCORE_PER_KILL, SCORE_PER_OUTLAST, SCORE_PER_WIN, THEME_COUNT } from "../shared/constants";
import {
  DEFAULT_SETTINGS,
  SETTING_CHOICES,
  arenaConfig,
  rankPlayers,
  type GameState,
  type PlayerState,
  type ServerMsg,
} from "../shared/protocol";

export { GameError, type GameIO } from "@warrick/kit/worker/lobby";

const CPU_NAMES = ["Bit", "Vector", "Kernel", "Daemon", "Sprite", "Cache", "Pixel", "Hex", "Null", "Glitch"];
const COUNTDOWN_MS = 3000;
const ROUNDOVER_MS = 4500;

export function newGameState(code: string, now: number): GameState {
  return {
    ...baseState(code, now, DEFAULT_SETTINGS),
    round: 0,
    theme: 0,
    roundWinnerId: null,
    phaseDeadline: null,
    timer: null,
    roundBase: null,
  };
}

/**
 * Light Cycles' rules on top of the kit's lobby: rounds, steering, the tick that moves the
 * cycles, scoring, and the countdown and pause between rounds. The lobby is only open in the
 * "lobby" phase, and a finished game sits in "gameover" until the host takes everyone back.
 */
export class Game extends Lobby<GameState, ServerMsg, Arena> {
  protected readonly choices = SETTING_CHOICES;
  protected readonly colors = PLAYER_COLORS;
  protected readonly cpuNames = CPU_NAMES;
  protected readonly finishedPhase = "gameover";

  constructor(
    s: GameState,
    io: GameIO,
    arena: Arena | null = null,
    private rng: Rng = mulberry32(randomSeed()),
  ) {
    super(s, io, arena);
  }

  /** The round in progress: the kit's `live`. It lives in memory only; see `recover()`. */
  get arena(): Arena | null {
    return this.live;
  }

  set arena(arena: Arena | null) {
    this.live = arena;
  }

  protected betweenRounds(): boolean {
    return this.s.phase === "lobby";
  }

  protected createPlayer(base: BasePlayer): PlayerState {
    // Everyone starts out connected, CPUs included.
    return { ...base, connected: true, score: 0, wins: 0, kills: 0 };
  }

  // ---------------------------------------------------------------- players

  /** Someone who leaves their name blank is "Rider 3", not "Player 3". */
  addHuman(rawName: string): PlayerState {
    return super.addHuman(cleanName(rawName, `Rider ${this.s.nextPlayerNum}`));
  }

  leave(id: string): void {
    const p = this.player(id);
    if (!p) return;
    if (this.s.phase === "lobby" || p.spectator) {
      super.leave(id);
    } else {
      // Their cycle rides on, straight into whatever is ahead.
      this.event(`${p.name} left the game`);
      this.setConnected(id, false);
    }
  }

  // ---------------------------------------------------------------- riding

  turn(id: string, dir: Dir, at?: number): void {
    const i = this.cycleIndex(id);
    if (i >= 0 && isDir(dir)) this.arena!.queueTurn(i, dir, at);
  }

  boost(id: string, at?: number): void {
    const i = this.cycleIndex(id);
    if (i >= 0 && this.s.phase === "playing") this.arena!.requestBoost(i, at);
  }

  private cycleIndex(id: string): number {
    const { phase } = this.s;
    if (!this.arena || (phase !== "countdown" && phase !== "playing")) return -1;
    return this.arena.index(id);
  }

  /** One step of the round. The room calls this on every tick while the phase is "playing". */
  tick(): void {
    const arena = this.arena;
    if (this.s.phase !== "playing" || !arena) return;
    arena.cycles.forEach((c, i) => {
      if (!c.alive) return;
      const cpu = this.player(c.id)?.cpu;
      if (!cpu) return;
      const move = steer(arena, i, cpu, this.rng);
      if (move.dir !== null) arena.queueTurn(i, move.dir);
      if (move.boost) arena.requestBoost(i);
    });

    const frame = arena.step();
    this.outbox.push({ t: "frame", f: frame });

    let crashed = 0;
    for (const ev of frame.e) {
      if (ev.k !== "crash") continue;
      crashed++;
      const victim = this.player(arena.cycles[ev.i].id);
      const other = ev.by >= 0 ? this.player(arena.cycles[ev.by].id) : undefined;
      if (!victim) continue;
      if (ev.headOn && other) {
        if (ev.i < ev.by) this.event(`💥 ${victim.name} and ${other.name} met head-on`);
      } else if (other && other.id !== victim.id) {
        other.kills++;
        other.score += SCORE_PER_KILL;
        this.event(`💥 ${victim.name} hit ${other.name}'s wall`);
      } else if (other) {
        this.event(`💥 ${victim.name} hit their own wall`);
      } else {
        this.event(
          arena.shrink > 0 ? `💥 ${victim.name} was caught by the closing wall` : `💥 ${victim.name} hit the arena wall`,
        );
      }
    }
    if (!crashed) return;

    // Everyone still riding outlasted everyone who just went down.
    for (const c of arena.cycles) {
      if (!c.alive) continue;
      const p = this.player(c.id);
      if (p) p.score += crashed * SCORE_PER_OUTLAST;
    }
    this.touch();
    if (arena.aliveCount <= 1) this.roundOver();
  }

  // ---------------------------------------------------------------- match flow

  start(byId: string): void {
    // Drops players who closed their tab in the lobby, and seats watchers in any free seats.
    this.beginStart(byId, 2, "riders");
    for (const p of this.s.players) p.kills = p.wins = p.score = 0;
    this.s.round = 0;
    this.event(`Game on! ${this.s.settings.rounds} round${this.s.settings.rounds > 1 ? "s" : ""}.`);
    this.startRound();
  }

  protected resetForLobby(): void {
    const s = this.s;
    s.round = 0;
    s.roundWinnerId = null;
    s.phaseDeadline = null;
    s.timer = null;
    s.roundBase = null;
    this.arena = null;
  }

  /**
   * Called when riders come back to a round that stopped ticking. A round
   * paused with nobody connected resumes after a countdown. The arena only
   * lives in memory, so if the room restarted, the round starts over.
   */
  recover(): void {
    const s = this.s;
    if (s.phase !== "countdown" && s.phase !== "playing") return;
    if (!this.arena) {
      // Points scored in the lost round are scored again in the replay, so take them back.
      // (A state saved before this field existed has no base, and keeps its points.)
      for (const p of s.players) {
        const base = s.roundBase?.[p.id];
        if (base) [p.score, p.kills] = base;
      }
      s.round--;
      this.event(`Round ${s.round + 1} was interrupted — restarting it`);
      this.startRound();
    } else if (s.phase === "playing" || (s.phaseDeadline ?? 0) < this.io.now()) {
      this.event(`Resuming round ${s.round}`);
      this.countdown();
    }
  }

  private startRound(): void {
    const s = this.s;
    const rng = this.rng;
    s.round++;
    s.roundWinnerId = null;
    s.roundBase = {};
    for (const p of s.players) s.roundBase[p.id] = [p.score, p.kills];
    s.theme = randInt(rng, 0, THEME_COUNT - 1);
    const cfg = arenaConfig(s.settings);
    // Riders who have gone away sit out (their cycle would only ride into a wall), unless that leaves too few.
    let riders = this.participants.filter((p) => p.cpu || this.io.isConnected(p.id));
    if (riders.length < 2) riders = this.participants;
    const ids = shuffle(
      rng,
      riders.map((p) => p.id),
    );
    const spots = spawnPoints(ids.length, cfg.w, cfg.h, rng);
    this.arena = Arena.create(
      cfg,
      ids.map((id, i) => ({ id, ...spots[i] })),
    );
    this.event(`Round ${s.round} of ${s.settings.rounds}`);
    this.countdown();
  }

  private countdown(): void {
    const s = this.s;
    s.phase = "countdown";
    s.phaseDeadline = this.io.now() + COUNTDOWN_MS;
    s.timer = { kind: "countdown", at: s.phaseDeadline };
    this.outbox.push({ t: "arena", arena: this.arena!.snapshot() });
    this.touch();
  }

  private roundOver(): void {
    const s = this.s;
    const survivor = this.arena!.cycles.find((c) => c.alive);
    const winner = survivor ? this.player(survivor.id) : undefined;
    s.phase = "roundover";
    if (winner) {
      winner.wins++;
      winner.score += SCORE_PER_WIN;
      this.event(`🏆 ${winner.name} wins round ${s.round}`);
    } else {
      this.event(`Round ${s.round} is a draw — nobody made it`);
    }
    s.roundWinnerId = winner?.id ?? null;
    s.phaseDeadline = this.io.now() + ROUNDOVER_MS;
    s.timer = { kind: "roundover", at: s.phaseDeadline };
    this.touch();
  }

  private afterRoundOver(): void {
    const s = this.s;
    if (s.round >= s.settings.rounds) {
      s.phase = "gameover";
      s.phaseDeadline = null;
      s.timer = null;
      const best = [...this.participants].sort(rankPlayers)[0];
      if (best) this.event(`🎉 ${best.name} wins the game!`);
      this.touch();
      return;
    }
    this.startRound();
  }

  // ---------------------------------------------------------------- timers

  onTimer(): void {
    // The arena was lost (the room restarted, or slept through the countdown): replay the round.
    if (!this.arena) this.recover();
    const s = this.s;
    const t = s.timer;
    if (!t || this.io.now() < t.at - 25) return;
    s.timer = null;
    switch (t.kind) {
      case "countdown":
        if (s.phase === "countdown") {
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
}
