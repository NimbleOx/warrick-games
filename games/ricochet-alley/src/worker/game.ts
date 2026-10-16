import type { BasePlayer } from "@warrick/kit/shared/protocol";
import { mulberry32, randInt, randomSeed, shuffle } from "@warrick/kit/shared/rng";
import { GameError, Lobby, baseState, type GameIO } from "@warrick/kit/worker/lobby";
import { CpuBrain } from "../shared/ai";
import { HANG_TICKS, MAZE_LOOPINESS, MAZE_SIZES, THEME_COUNT } from "../shared/constants";
import { generateMaze, pickSpawns } from "../shared/maze";
import {
  DEFAULT_SETTINGS,
  EV_FIRE,
  EV_HIT,
  SETTING_CHOICES,
  mazeSizeFor,
  rankPlayers,
  type FrameEvent,
  type FrameTank,
  type GameState,
  type PlayerState,
  type ServerMsg,
} from "../shared/protocol";
import { IN_MASK, POS_SCALE, World, startingTanks } from "../shared/sim";

export { GameError, type GameIO } from "@warrick/kit/worker/lobby";

/** A human's latest input: held bits, the sequence number of that change, and ticks it has been applied for. */
export interface InputState {
  bits: number;
  seq: number;
  age: number;
}

/** The round in progress. Memory only: it changes every tick, far too often to persist. */
export interface LiveRound {
  world: World;
  /** CPU brains by tank index. */
  brains: Map<number, CpuBrain>;
  /** Tick at which the round ends now that one tank (or none) is left; −1 while it's still a fight. */
  hangUntil: number;
}

/** What the room keeps in memory between messages and ticks. */
export interface Live {
  round: LiveRound | null;
  inputs: Map<string, InputState>;
}

const CPU_NAMES = ["Bert", "Ziggy", "Moe", "Pixel", "Dozer", "Rusty", "Boomer", "Clank", "Mortimer", "Spud"];
export const COUNTDOWN_MS = 3000;
const ROUNDOVER_MS = 3500;
/** Humans who dropped this recently still get a tank in the next round (a reload, a deploy). */
const AWAY_GRACE_MS = 20000;

export function newGameState(code: string, now: number): GameState {
  return { ...baseState(code, now, DEFAULT_SETTINGS), round: 0, setup: null, roundWinnerId: null, phaseDeadline: null, timer: null };
}

export function newLive(): Live {
  return { round: null, inputs: new Map() };
}

/**
 * Ricochet Alley's rules on top of the kit's lobby: input, rounds, the tick, scoring, and the timers between
 * rounds. The lobby is only open in the "lobby" phase, and a finished match sits in "gameover" until the host
 * takes everyone back. The room owns the sockets, storage, alarm and tick loop; this only changes `s` and
 * `live` and queues messages.
 */
export class Game extends Lobby<GameState, ServerMsg, Live> {
  declare live: Live;
  protected readonly choices = SETTING_CHOICES;
  protected readonly cpuNames = CPU_NAMES;
  protected readonly finishedPhase = "gameover";

  constructor(s: GameState, io: GameIO, live: Live | null = null) {
    super(s, io, live ?? newLive());
  }

  protected betweenRounds(): boolean {
    return this.s.phase === "lobby";
  }

  /** Arriving after a match is over gets you a tank for the next one; mid-match, you watch until the next round. */
  protected joinMidGame(): boolean {
    return this.s.phase === "gameover";
  }

  protected createPlayer(base: BasePlayer): PlayerState {
    // CPUs count as connected too.
    return { ...base, connected: true, awaySince: null, score: 0, kills: 0, selfHits: 0 };
  }

  // ---------------------------------------------------------------- players

  addHuman(rawName: string): PlayerState {
    const p = super.addHuman(rawName);
    // The lobby logged them as watching; mid-match there's usually a tank for them next round.
    const joined = this.logs.at(-1);
    if (p.spectator && this.inMatch() && this.participants.length < this.maxPlayers && joined) {
      joined.text = `${p.name} joined — in from the next round`;
    }
    return p;
  }

  leave(id: string): void {
    const p = this.player(id);
    if (!p) return;
    if (this.inMatch() && !p.spectator) {
      // Their tank leaves with them; scores so far go too.
      this.removeTank(id);
      this.removePlayer(id);
      this.event(`${p.name} left the game`);
    } else {
      super.leave(id);
    }
    this.live.inputs.delete(id);
  }

  setConnected(id: string, connected: boolean): void {
    const p = this.player(id);
    if (!p || p.cpu) return;
    p.connected = connected;
    p.awaySince = connected ? null : this.io.now();
    if (connected) {
      this.resetInput(id);
    } else {
      // A dropped player's tank stops where it is (it can still be shot).
      const inp = this.live.inputs.get(id);
      if (inp) inp.bits = 0;
    }
    this.touch();
  }

  /** A new connection for this player: their input starts over from sequence 0. */
  resetInput(id: string): void {
    this.live.inputs.set(id, { bits: 0, seq: 0, age: 0 });
  }

  // ---------------------------------------------------------------- input

  /** An input message from a human: new held bits (sequence `seq`), and maybe a fire press. */
  input(id: string, seq: number, bits: number, fire: boolean): void {
    const inp = this.live.inputs.get(id) ?? { bits: 0, seq: 0, age: 0 };
    if (Number.isInteger(seq) && seq > inp.seq) {
      inp.seq = seq;
      inp.bits = (bits | 0) & IN_MASK;
      inp.age = 0;
    }
    this.live.inputs.set(id, inp);
    if (fire && this.s.phase === "playing" && this.live.round) {
      const i = this.s.setup?.tanks.indexOf(id) ?? -1;
      if (i >= 0) this.live.round.world.requestFire(i);
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
    if (this.participants.length < 2) throw new GameError("Need at least two tanks — add a CPU?");
    for (const p of this.s.players) p.score = p.kills = p.selfHits = 0;
    this.s.round = 0;
    this.event(`Game on! First to ${this.s.settings.target} wins.`);
    this.startRound();
  }

  /** Back to the lobby: forget the match, and drop players who closed their tab. */
  protected resetForLobby(): void {
    const s = this.s;
    s.round = 0;
    s.setup = null;
    s.roundWinnerId = null;
    s.phaseDeadline = null;
    s.timer = null;
    this.live.round = null;
    for (const p of [...s.players]) {
      if (!p.cpu && !p.connected) this.removePlayer(p.id);
    }
  }

  /** Who gets a tank this round. Spectators waiting for a round come in if there's room. */
  private roundPlayers(): PlayerState[] {
    const now = this.io.now();
    for (const p of this.s.players) {
      if (p.spectator && !p.cpu && p.connected && this.participants.length < this.maxPlayers) {
        p.spectator = false;
        this.event(`${p.name} is in`);
      }
    }
    return this.participants.filter((p) => p.cpu || p.connected || now - (p.awaySince ?? 0) < AWAY_GRACE_MS);
  }

  private startRound(): void {
    const s = this.s;
    const players = this.roundPlayers();
    if (players.length < 2) {
      this.event("Not enough tanks left to play on");
      this.gameOver();
      return;
    }
    const rng = mulberry32(randomSeed());
    const ids = shuffle(rng, players.map((p) => p.id));
    const { cols, rows } = MAZE_SIZES[mazeSizeFor(s.settings.maze, ids.length)];
    const maze = generateMaze(rng, cols, rows, MAZE_LOOPINESS);
    const tanks = startingTanks(ids, pickSpawns(maze, ids.length, rng));
    s.round++;
    s.setup = { maze, theme: randInt(rng, 0, THEME_COUNT - 1), tanks: ids, start: { tick: 0, nextId: 1, tanks, bullets: [] } };
    s.roundWinnerId = null;
    this.beginRound(`Round ${s.round}`);
  }

  /** Build the live round from the stored setup (or carry on with `keep`) and count down to it. */
  private beginRound(announce: string | null, keep?: LiveRound): void {
    const s = this.s;
    const setup = s.setup!;
    if (keep) {
      this.live.round = keep;
    } else {
      const world = new World(setup.maze, setup.start);
      const brains = new Map<number, CpuBrain>();
      setup.tanks.forEach((id, i) => {
        const p = this.player(id);
        if (!p) world.tanks[i].alive = false; // left while the round was being rebuilt
        else if (p.cpu) brains.set(i, new CpuBrain(p.cpu, mulberry32(randomSeed())));
      });
      this.live.round = { world, brains, hangUntil: -1 };
    }
    const world = this.live.round.world;
    // Input ages count ticks of this world from here, which is what clients line their prediction up with.
    for (const inp of this.live.inputs.values()) inp.age = 0;
    s.phase = "countdown";
    s.phaseDeadline = this.io.now() + COUNTDOWN_MS;
    s.timer = { kind: "countdown", at: s.phaseDeadline };
    if (announce) this.event(announce);
    // The state goes first: clients need the round's setup (its maze, who drives which tank) to make sense of
    // its world. Sent here, it also stands in for the room's own state message, which would come after.
    this.outbox.push({ t: "state", state: s, now: this.io.now() }, { t: "round", world: world.snapshot() });
    this.touch();
  }

  /**
   * The room lost its memory mid-round (a deploy restarts every Durable Object), or nobody was here to
   * watch: start the current round again from its starting positions, with a fresh countdown.
   */
  recover(): void {
    const s = this.s;
    if ((s.phase !== "countdown" && s.phase !== "playing") || !s.setup || this.live.round) return;
    this.beginRound(`Round ${s.round} restarted`);
  }

  /** The round paused because nobody was connected; someone's back, so count down and carry on. */
  resume(): void {
    const live = this.live.round;
    if (this.s.phase !== "playing" || !live) return;
    this.beginRound(`Round ${this.s.round} resumes`, live);
  }

  /**
   * Someone connected. Pick the round back up if it stalled: rebuild it after a restart, resume it if the tick
   * loop isn't running, or restart a countdown that ran out while nobody was here to see it.
   */
  wake(loopRunning: boolean): void {
    const s = this.s;
    // After a restart the room marks everyone who hasn't reconnected yet as offline. As far as the grace
    // period goes, they dropped just now.
    for (const p of s.players) {
      if (!p.cpu && !p.connected && p.awaySince === null) p.awaySince = this.io.now();
    }
    if (!this.live.round) this.recover();
    else if (s.phase === "playing" && !loopRunning) this.resume();
    else if (s.phase === "countdown" && (s.phaseDeadline ?? 0) <= this.io.now()) {
      // Only once it's run out: one still going is everyone's, and someone arriving doesn't push it back.
      s.phaseDeadline = this.io.now() + COUNTDOWN_MS;
      s.timer = { kind: "countdown", at: s.phaseDeadline };
      this.touch();
    }
  }

  /** One server tick of the round in progress. */
  tick(): void {
    const s = this.s;
    const live = this.live.round;
    if (s.phase !== "playing" || !live || !s.setup) return;
    const w = live.world;
    const ids = s.setup.tanks;
    const bits = ids.map((id, i) => {
      const brain = live.brains.get(i);
      if (!brain) return this.live.inputs.get(id)?.bits ?? 0;
      const m = brain.think(w, i);
      if (m.fire) w.requestFire(i);
      return m.bits;
    });
    const events = w.step(bits);
    for (const id of ids) {
      const inp = this.live.inputs.get(id);
      if (inp) inp.age++;
    }

    const e: FrameEvent[] = [];
    for (const ev of events) {
      if (ev.k === "fire") {
        const b = ev.b;
        e.push([EV_FIRE, b.id, b.o, b.x, b.y, b.vx, b.vy]);
      } else if (ev.k === "hit") {
        e.push([EV_HIT, ev.b, ev.o, ev.t, round1(ev.x), round1(ev.y)]);
        this.scoreHit(ids[ev.o], ids[ev.t]);
      }
    }
    this.outbox.push({ t: "f", n: w.tick, k: this.frameTanks(), ...(e.length ? { e } : {}) });

    if (live.hangUntil < 0 && w.aliveCount <= 1) live.hangUntil = w.tick + HANG_TICKS;
    if (live.hangUntil >= 0 && w.tick >= live.hangUntil) {
      const alive = w.tanks.filter((t) => t.alive);
      this.roundOver(alive.length === 1 ? (alive[0].id ?? null) : null);
    }
  }

  frameTanks(): FrameTank[] {
    const live = this.live.round;
    if (!live) return [];
    return live.world.tanks.map((t) => {
      if (!t.alive) return 0;
      const pose = [Math.round(t.x * POS_SCALE), Math.round(t.y * POS_SCALE), t.h, t.tt];
      const inp = this.live.inputs.get(t.id);
      return this.player(t.id)?.cpu || !inp ? pose : [...pose, inp.seq, inp.age];
    });
  }

  private scoreHit(shooterId: string, victimId: string): void {
    const shooter = this.player(shooterId);
    const victim = this.player(victimId);
    if (!victim) return;
    if (shooterId === victimId) {
      victim.selfHits++;
      this.event(`💥 ${victim.name} was hit by their own bullet`);
    } else {
      if (shooter) shooter.kills++;
      this.event(`💥 ${shooter?.name ?? "Someone"} got ${victim.name}`);
    }
  }

  private removeTank(id: string): void {
    const live = this.live.round;
    const i = this.s.setup?.tanks.indexOf(id) ?? -1;
    if (live && i >= 0) {
      live.world.tanks[i].alive = false;
      live.brains.delete(i);
    }
  }

  private roundOver(winnerId: string | null): void {
    const s = this.s;
    s.phase = "roundover";
    const winner = winnerId ? this.player(winnerId) : undefined;
    if (winner) {
      winner.score++;
      this.event(`🏆 ${winner.name} wins round ${s.round} (${winner.score}/${s.settings.target})`);
    } else {
      this.event(`Round ${s.round} is a draw — nobody survived`);
    }
    s.roundWinnerId = winner?.id ?? null;
    s.phaseDeadline = this.io.now() + ROUNDOVER_MS;
    s.timer = { kind: "roundover", at: s.phaseDeadline };
    this.touch();
  }

  private afterRoundOver(): void {
    if (this.participants.some((p) => p.score >= this.s.settings.target)) this.gameOver();
    else this.startRound();
  }

  private gameOver(): void {
    const s = this.s;
    s.phase = "gameover";
    s.phaseDeadline = null;
    s.timer = null;
    this.live.round = null;
    const best = [...this.participants].sort(rankPlayers)[0];
    if (best) this.event(`🎉 ${best.name} wins the game!`);
    this.touch();
  }

  // ---------------------------------------------------------------- timers

  onTimer(): void {
    const s = this.s;
    const t = s.timer;
    if (!t || this.io.now() < t.at - 25) return;
    s.timer = null;
    switch (t.kind) {
      case "countdown":
        if (s.phase === "countdown" && this.live.round) {
          s.phase = "playing";
          s.phaseDeadline = null;
        } else {
          this.recover();
        }
        break;
      case "roundover":
        if (s.phase === "roundover") this.afterRoundOver();
        break;
    }
    this.touch();
  }

  // ---------------------------------------------------------------- helpers

  /** A match is on: from its first countdown until it's over. */
  private inMatch(): boolean {
    return this.s.phase !== "lobby" && this.s.phase !== "gameover";
  }
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
