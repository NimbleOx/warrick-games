import { steer } from "../shared/ai";
import { Arena, isDir, spawnPoints, type Dir } from "../shared/arena";
import {
  MAX_PLAYERS,
  PLAYER_COLORS,
  SCORE_PER_KILL,
  SCORE_PER_OUTLAST,
  SCORE_PER_WIN,
  THEME_COUNT,
} from "../shared/constants";
import {
  DEFAULT_SETTINGS,
  SETTING_CHOICES,
  arenaConfig,
  rankPlayers,
  type CpuLevel,
  type GameState,
  type LogEntry,
  type PlayerState,
  type ServerMsg,
  type Settings,
} from "../shared/protocol";
import { mulberry32, randInt, randomSeed, shuffle, type Rng } from "../shared/rng";

export class GameError extends Error {}

export interface GameIO {
  now(): number;
  isConnected(playerId: string): boolean;
}

const CPU_NAMES = ["Bit", "Vector", "Kernel", "Daemon", "Sprite", "Cache", "Pixel", "Hex", "Null", "Glitch"];
const COUNTDOWN_MS = 3000;
const ROUNDOVER_MS = 4500;

export function newGameState(code: string, now: number): GameState {
  return {
    code,
    createdAt: now,
    lastActive: now,
    phase: "lobby",
    hostId: "",
    settings: { ...DEFAULT_SETTINGS },
    players: [],
    round: 0,
    theme: 0,
    roundWinnerId: null,
    phaseDeadline: null,
    timer: null,
    nextPlayerNum: 1,
  };
}

export function cleanName(raw: unknown, fallback: string): string {
  const s = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16);
  return s || fallback;
}

/**
 * All the game rules, as plain state transitions. The Durable Object owns the
 * sockets, storage, alarm and tick loop; this class only mutates `s` and the
 * arena, and queues messages.
 */
export class Game {
  /** Messages to broadcast once the current action is done. */
  outbox: ServerMsg[] = [];
  logs: LogEntry[] = [];
  dirty = false;

  constructor(
    public s: GameState,
    private io: GameIO,
    /** The round in progress. Lives in memory only; see `recover()`. */
    public arena: Arena | null = null,
    private rng: Rng = mulberry32(randomSeed()),
  ) {}

  // ---------------------------------------------------------------- players

  player(id: string): PlayerState | undefined {
    return this.s.players.find((p) => p.id === id);
  }

  get participants(): PlayerState[] {
    return this.s.players.filter((p) => !p.spectator);
  }

  addHuman(rawName: string): PlayerState {
    const id = `p${this.s.nextPlayerNum++}`;
    const name = cleanName(rawName, `Rider ${id.slice(1)}`);
    const spectator = this.s.phase !== "lobby" || this.participants.length >= MAX_PLAYERS;
    const p = this.newPlayer(id, name, null, spectator);
    this.s.players.push(p);
    if (!this.s.hostId || !this.player(this.s.hostId)) this.s.hostId = id;
    this.event(spectator ? `${name} is watching` : `${name} joined`);
    this.touch();
    return p;
  }

  addCpu(byId: string, level: CpuLevel): void {
    this.requireHost(byId);
    this.requirePhase("lobby");
    if (!["easy", "normal", "hard"].includes(level)) throw new GameError("Unknown CPU level");
    if (this.participants.length >= MAX_PLAYERS) throw new GameError("The game is full");
    const used = new Set(this.s.players.map((p) => p.name));
    const name = `CPU ${CPU_NAMES.find((n) => !used.has(`CPU ${n}`)) ?? this.s.nextPlayerNum}`;
    const p = this.newPlayer(`p${this.s.nextPlayerNum++}`, name, level, false);
    this.s.players.push(p);
    this.event(`${name} (${level}) joined`);
    this.touch();
  }

  /** Returns true if a human was removed, so the caller can close their sockets. */
  kick(byId: string, targetId: string): boolean {
    this.requireHost(byId);
    this.requirePhase("lobby");
    const target = this.player(targetId);
    if (!target || targetId === byId) return false;
    this.removePlayer(targetId);
    this.event(`${target.name} was removed`);
    return !target.cpu;
  }

  leave(id: string): void {
    const p = this.player(id);
    if (!p) return;
    if (this.s.phase === "lobby" || p.spectator) {
      this.removePlayer(id);
      this.event(`${p.name} left`);
    } else {
      // Their cycle rides on, straight into whatever is ahead.
      this.event(`${p.name} left the game`);
      this.setConnected(id, false);
    }
  }

  setConnected(id: string, connected: boolean): void {
    const p = this.player(id);
    if (!p || p.cpu || p.connected === connected) return;
    p.connected = connected;
    this.touch();
  }

  rename(id: string, rawName: string): void {
    const p = this.player(id);
    if (!p || this.s.phase !== "lobby") return;
    const name = cleanName(rawName, p.name);
    if (name === p.name) return;
    p.name = name;
    this.touch();
  }

  setColor(id: string, color: string): void {
    this.requirePhase("lobby");
    const p = this.player(id);
    if (!p || !(PLAYER_COLORS as readonly string[]).includes(color)) return;
    const taken = this.s.players.find((o) => o.id !== id && o.color === color);
    if (taken) taken.color = p.color;
    p.color = color;
    this.touch();
  }

  updateSettings(byId: string, patch: Partial<Settings>): void {
    this.requireHost(byId);
    this.requirePhase("lobby");
    const next = { ...this.s.settings };
    for (const key of Object.keys(SETTING_CHOICES) as (keyof Settings)[]) {
      const v = patch[key];
      if (v !== undefined && (SETTING_CHOICES[key] as readonly unknown[]).includes(v)) {
        (next as Record<string, unknown>)[key] = v;
      }
    }
    this.s.settings = next;
    this.touch();
  }

  chat(id: string, raw: string): void {
    const p = this.player(id);
    const text = String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
    if (!p || !text) return;
    this.logs.push({ at: this.io.now(), kind: "chat", from: p.name, color: p.color, text });
  }

  // ---------------------------------------------------------------- riding

  turn(id: string, dir: Dir): void {
    const i = this.cycleIndex(id);
    if (i >= 0 && isDir(dir)) this.arena!.queueTurn(i, dir);
  }

  boost(id: string): void {
    const i = this.cycleIndex(id);
    if (i >= 0 && this.s.phase === "playing") this.arena!.requestBoost(i);
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
        this.event(arena.shrink > 0 ? `💥 ${victim.name} was caught by the closing wall` : `💥 ${victim.name} hit the arena wall`);
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
    this.requireHost(byId);
    this.requirePhase("lobby");
    // Players who closed their tab in the lobby don't hold up the game.
    for (const p of [...this.s.players]) {
      if (!p.cpu && !p.connected) this.removePlayer(p.id);
    }
    if (this.participants.length < 2) throw new GameError("Need at least two riders — add a CPU?");
    for (const p of this.s.players) p.kills = p.wins = p.score = 0;
    this.s.round = 0;
    this.event(`Game on! ${this.s.settings.rounds} round${this.s.settings.rounds > 1 ? "s" : ""}.`);
    this.startRound();
  }

  backToLobby(byId: string): void {
    this.requireHost(byId);
    this.requirePhase("gameover");
    const s = this.s;
    s.phase = "lobby";
    s.round = 0;
    s.roundWinnerId = null;
    s.phaseDeadline = null;
    s.timer = null;
    this.arena = null;
    for (const p of s.players) {
      if (p.spectator && this.participants.length < MAX_PLAYERS) p.spectator = false;
    }
    this.touch();
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
    s.theme = randInt(rng, 0, THEME_COUNT - 1);
    const cfg = arenaConfig(s.settings);
    // Riders who have gone away sit out (their cycle would only ride into a wall), unless that leaves too few.
    let riders = this.participants.filter((p) => p.cpu || this.io.isConnected(p.id));
    if (riders.length < 2) riders = this.participants;
    const ids = shuffle(rng, riders.map((p) => p.id));
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

  // ---------------------------------------------------------------- helpers

  private newPlayer(id: string, name: string, cpu: CpuLevel | null, spectator: boolean): PlayerState {
    const used = new Set(this.s.players.map((p) => p.color));
    const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[this.s.players.length % PLAYER_COLORS.length];
    return { id, name, color, cpu, connected: true, spectator, score: 0, wins: 0, kills: 0 };
  }

  private removePlayer(id: string): void {
    const s = this.s;
    s.players = s.players.filter((p) => p.id !== id);
    if (s.hostId === id) {
      const next = s.players.find((p) => !p.cpu && p.connected) ?? s.players.find((p) => !p.cpu);
      s.hostId = next?.id ?? "";
    }
    this.touch();
  }

  /** Host-only actions. If the host has dropped, whoever acts takes over. */
  private requireHost(id: string): void {
    const s = this.s;
    if (s.hostId === id) return;
    const host = this.player(s.hostId);
    const me = this.player(id);
    if (me && !me.cpu && (!host || !this.io.isConnected(host.id))) {
      s.hostId = id;
      this.event(`${me.name} is now the host`);
      return;
    }
    throw new GameError("Only the host can do that");
  }

  private requirePhase(phase: GameState["phase"]): void {
    if (this.s.phase !== phase) throw new GameError("Not right now");
  }

  private event(text: string): void {
    this.logs.push({ at: this.io.now(), kind: "event", text });
  }

  private touch(): void {
    this.dirty = true;
    this.s.lastActive = this.io.now();
  }
}
