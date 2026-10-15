import { autopilot, newBrain, think, type Brain } from "../shared/ai";
import { isDir } from "../shared/board";
import { MAX_PLAYERS, PLAYER_COLORS, TICKS_PER_SEC } from "../shared/constants";
import {
  BOARD_SIZES,
  DEFAULT_SETTINGS,
  SETTING_CHOICES,
  percent,
  type CpuLevel,
  type GameState,
  type LogEntry,
  type PlayerState,
  type RoundResult,
  type ServerMsg,
  type Settings,
  type Snapshot,
  type Standing,
} from "../shared/protocol";
import { mulberry32, randomSeed, type Rng } from "../shared/rng";
import { Round } from "../shared/sim";

export class GameError extends Error {}

export interface GameIO {
  now(): number;
  isConnected(playerId: string): boolean;
}

/** The round being played. It changes every tick, so it lives in memory only. */
export interface Live {
  round: Round;
  /** CPU memory, by board slot. */
  brains: (Brain | null)[];
  rng: Rng;
}

const CPU_NAMES = ["Rex", "Pixel", "Turbo", "Moss", "Gizmo", "Pebble", "Blitz", "Nugget", "Sprout", "Zapp"];

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
    results: null,
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
 * sockets, storage and the tick loop; this class only changes `s` and `live`
 * and queues messages.
 */
export class Game {
  /** Messages to broadcast once the current action is done. */
  outbox: ServerMsg[] = [];
  logs: LogEntry[] = [];
  /** `s` changed: broadcast it and save it. */
  dirty = false;

  constructor(
    public s: GameState,
    private io: GameIO,
    public live: Live | null = null,
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
    const name = cleanName(rawName, `Player ${id.slice(1)}`);
    const p = this.newPlayer(id, name, null);
    if (this.participants.length >= MAX_PLAYERS) p.spectator = true;
    else if (this.s.phase === "playing" && !this.seat(p)) p.spectator = true;
    this.s.players.push(p);
    if (!this.s.hostId || !this.player(this.s.hostId)) this.s.hostId = id;
    this.event(p.spectator ? `${name} is watching` : `${name} joined`);
    this.touch();
    return p;
  }

  addCpu(byId: string, level: CpuLevel): void {
    this.requireHost(byId);
    this.requireBetweenRounds();
    if (!["easy", "normal", "hard"].includes(level)) throw new GameError("Unknown CPU level");
    if (this.participants.length >= MAX_PLAYERS) throw new GameError(`The game is full (${MAX_PLAYERS} players)`);
    const used = new Set(this.s.players.map((p) => p.name));
    const name = `CPU ${CPU_NAMES.find((n) => !used.has(`CPU ${n}`)) ?? this.s.nextPlayerNum}`;
    const p = this.newPlayer(`p${this.s.nextPlayerNum++}`, name, level);
    this.s.players.push(p);
    this.event(`${name} (${level}) joined`);
    this.touch();
  }

  /** Returns true if a human was removed, so the caller can close their sockets. */
  kick(byId: string, targetId: string): boolean {
    this.requireHost(byId);
    this.requireBetweenRounds();
    const target = this.player(targetId);
    if (!target || targetId === byId) return false;
    this.removePlayer(targetId);
    this.event(`${target.name} was removed`);
    return !target.cpu;
  }

  leave(id: string): void {
    const p = this.player(id);
    if (!p) return;
    if (p.slot >= 0) this.live?.round.leave(p.slot);
    this.removePlayer(id);
    this.event(`${p.name} left`);
  }

  setConnected(id: string, connected: boolean): void {
    const p = this.player(id);
    if (!p || p.cpu || p.connected === connected) return;
    p.connected = connected;
    this.touch();
  }

  rename(id: string, rawName: string): void {
    const p = this.player(id);
    if (!p || this.s.phase === "playing") return;
    const name = cleanName(rawName, p.name);
    if (name === p.name) return;
    p.name = name;
    this.touch();
  }

  setColor(id: string, color: string): void {
    this.requireBetweenRounds();
    const p = this.player(id);
    if (!p || !(PLAYER_COLORS as readonly string[]).includes(color)) return;
    const taken = this.s.players.find((o) => o.id !== id && o.color === color);
    if (taken) taken.color = p.color;
    p.color = color;
    this.touch();
  }

  updateSettings(byId: string, patch: Partial<Settings>): void {
    this.requireHost(byId);
    this.requireBetweenRounds();
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

  // ---------------------------------------------------------------- match flow

  /** Start a round, from the lobby or from the last round's results. */
  start(byId: string): void {
    this.requireHost(byId);
    this.requireBetweenRounds();
    // Players who closed their tab between rounds don't get a seat.
    for (const p of [...this.s.players]) {
      if (!p.cpu && !p.connected) this.removePlayer(p.id);
    }
    this.promoteSpectators();
    if (this.participants.length < 2) throw new GameError("Need at least two players — add a CPU?");
    this.s.round++;
    this.participants.forEach((p, i) => (p.slot = i));
    this.startRound();
    const { w, h } = BOARD_SIZES[this.s.settings.board];
    const mins = this.s.settings.roundSeconds / 60;
    this.event(`Round ${this.s.round}: ${mins} minute${mins === 1 ? "" : "s"} on a ${w} × ${h} board. Go!`);
  }

  backToLobby(byId: string): void {
    this.requireHost(byId);
    if (this.s.phase !== "results") throw new GameError("Not right now");
    this.s.phase = "lobby";
    this.s.results = null;
    this.promoteSpectators();
    this.touch();
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
  private seat(p: PlayerState): boolean {
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

  private promoteSpectators(): void {
    for (const p of this.s.players) {
      if (p.spectator && this.participants.length < MAX_PLAYERS) p.spectator = false;
    }
  }

  private newPlayer(id: string, name: string, cpu: CpuLevel | null): PlayerState {
    const used = new Set(this.s.players.map((p) => p.color));
    const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0];
    return { id, name, color, cpu, connected: !cpu, spectator: false, slot: -1, wins: 0 };
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

  private requireBetweenRounds(): void {
    if (this.s.phase === "playing") throw new GameError("Wait for the round to end");
  }

  private event(text: string): void {
    this.logs.push({ at: this.io.now(), kind: "event", text });
  }

  private touch(): void {
    this.dirty = true;
    this.s.lastActive = this.io.now();
  }
}
