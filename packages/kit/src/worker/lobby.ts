import { CPU_LEVELS, DEFAULT_COLORS, MAX_PLAYERS, MAX_SPECTATORS } from "../shared/constants";
import type { BasePlayer, BaseState, CpuLevel, LogEntry } from "../shared/protocol";

/** A rule the player broke. The room sends the message back to them as an error. */
export class GameError extends Error {}

/** What a game needs from the room it runs in. */
export interface GameIO {
  now(): number;
  isConnected(playerId: string): boolean;
}

const CPU_NAMES = ["Rex", "Pixel", "Turbo", "Moss", "Gizmo", "Pebble", "Blitz", "Nugget", "Sprout", "Zapp"];

export function cleanName(raw: unknown, fallback: string): string {
  const s = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16);
  return s || fallback;
}

/** The fields every game's state starts with. Spread it into the game's own `newGameState`. */
export function baseState<S extends object>(code: string, now: number, settings: S) {
  return {
    code,
    createdAt: now,
    lastActive: now,
    phase: "lobby" as const,
    hostId: "",
    settings: { ...settings },
    players: [],
    nextPlayerNum: 1,
  };
}

/**
 * The rules every game shares: joining, the host, CPU players, colours, settings, kicking,
 * leaving, chat and the event log. A game extends this with its own rules (starting, playing,
 * finishing) and overrides whatever it does differently.
 *
 * Like the rest of a game's rules, it only changes `s` (and `live`, the game's in-memory
 * state) and queues messages; the room owns sockets, storage and timers. A fresh instance is
 * made for every action.
 */
export abstract class Lobby<S extends BaseState, M extends { t: string } = { t: string }, L = unknown> {
  /** Messages to broadcast once the current action is done. */
  outbox: M[] = [];
  /** Messages for one player only. */
  direct: { pid: string; msg: M }[] = [];
  logs: LogEntry[] = [];
  /** `s` changed: broadcast it and save it. */
  dirty = false;

  /** The allowed values of each setting. `updateSettings` takes nothing else. */
  protected abstract readonly choices: Readonly<Record<string, readonly unknown[]>>;
  protected readonly colors: readonly string[] = DEFAULT_COLORS;
  /** CPU players are called "CPU <name>", with the first of these not yet taken. */
  protected readonly cpuNames: readonly string[] = CPU_NAMES;
  protected readonly maxPlayers: number = MAX_PLAYERS;
  /** Most people watching at once. */
  protected readonly maxSpectators: number = MAX_SPECTATORS;
  /** The phase a finished game sits in, which "back to lobby" leaves. */
  protected readonly finishedPhase: string = "results";

  constructor(
    public s: S,
    protected io: GameIO,
    public live: L | null = null,
  ) {}

  /** Start the game (or the next round). Usually begins with `this.beginStart(byId)`. */
  abstract start(byId: string): void;

  /** Fill in a new player's game-specific fields. */
  protected abstract createPlayer(base: BasePlayer): S["players"][number];

  /** Runs on the room's tick, for games that have one. */
  tick?(): void;
  /** Runs when the room's alarm reaches `timerAt`, for games that use one. */
  onTimer?(): void;

  // ---------------------------------------------------------------- players

  player(id: string): S["players"][number] | undefined {
    return this.s.players.find((p) => p.id === id);
  }

  get participants(): S["players"] {
    return this.s.players.filter((p) => !p.spectator);
  }

  addHuman(rawName: string): S["players"][number] {
    const id = `p${this.s.nextPlayerNum++}`;
    const name = cleanName(rawName, `Player ${id.slice(1)}`);
    const p = this.newPlayer(id, name, null);
    if (this.participants.length >= this.maxPlayers) p.spectator = true;
    else if (!this.betweenRounds() && !this.joinMidGame(p)) p.spectator = true;
    this.s.players.push(p);
    if (!this.s.hostId || !this.player(this.s.hostId)) this.s.hostId = id;
    this.event(p.spectator ? `${name} is watching` : `${name} joined`);
    this.touch();
    return p;
  }

  /**
   * Make space for someone new, before `addHuman`. Anyone past the seats watches, so watchers are
   * capped too: at the cap, watchers who have gone are forgotten, and if that frees nobody's
   * place, it's false and nobody new can come in.
   */
  makeSpace(): boolean {
    // They'll get a seat.
    if (this.betweenRounds() && this.participants.length < this.maxPlayers) return true;
    const watching = () => this.s.players.filter((p) => p.spectator);
    if (watching().length < this.maxSpectators) return true;
    for (const p of watching()) if (!p.cpu && !this.io.isConnected(p.id)) this.removePlayer(p.id);
    return watching().length < this.maxSpectators;
  }

  addCpu(byId: string, level: CpuLevel): void {
    this.requireHost(byId);
    this.requireBetweenRounds();
    if (!CPU_LEVELS.includes(level)) throw new GameError("Unknown CPU level");
    if (this.participants.length >= this.maxPlayers) throw new GameError(`The game is full (${this.maxPlayers} players)`);
    const used = new Set(this.s.players.map((p) => p.name));
    const name = `CPU ${this.cpuNames.find((n) => !used.has(`CPU ${n}`)) ?? this.s.nextPlayerNum}`;
    const p = this.newPlayer(`p${this.s.nextPlayerNum++}`, name, level);
    this.s.players.push(p);
    this.event(`${name} (${level}) joined`);
    this.touch();
  }

  /** Returns true if a human was removed, so the room can close their sockets. */
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
    if (!p || !this.betweenRounds()) return;
    const name = cleanName(rawName, p.name);
    if (name === p.name) return;
    p.name = name;
    this.touch();
  }

  setColor(id: string, color: string): void {
    this.requireBetweenRounds();
    const p = this.player(id);
    if (!p || !this.colors.includes(color) || p.color === color) return;
    const taken = this.s.players.find((o) => o.id !== id && o.color === color);
    if (taken) taken.color = p.color;
    p.color = color;
    this.touch();
  }

  updateSettings(byId: string, patch: Record<string, unknown>): void {
    this.requireHost(byId);
    this.requireBetweenRounds();
    const next: Record<string, unknown> = { ...this.s.settings };
    for (const [key, allowed] of Object.entries(this.choices)) {
      const v = patch?.[key];
      if (v !== undefined && allowed.includes(v)) next[key] = v;
    }
    this.s.settings = next as S["settings"];
    this.touch();
  }

  chat(id: string, raw: string): void {
    const p = this.player(id);
    const text = String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
    if (!p || !text) return;
    this.logs.push({ at: this.io.now(), kind: "chat", from: p.name, color: p.color, text });
  }

  backToLobby(byId: string): void {
    this.requireHost(byId);
    if (this.s.phase !== this.finishedPhase) throw new GameError("Not right now");
    this.s.phase = "lobby";
    this.resetForLobby();
    this.promoteSpectators();
    this.touch();
  }

  // ---------------------------------------------------------------- for games

  /**
   * Whether lobby things (CPUs, settings, colours, kicking) can change now, and whether a new
   * arrival can take a seat. By default: whenever a game isn't being played.
   */
  protected betweenRounds(): boolean {
    return this.s.phase !== "playing";
  }

  /** Try to seat a player who arrives mid-game. Return false to have them watch instead. */
  protected joinMidGame(_p: S["players"][number]): boolean {
    return false;
  }

  /** Clear the finished game's state on the way back to the lobby. */
  protected resetForLobby(): void {}

  /**
   * The usual checks before a start: host only, between rounds, drop humans who closed their
   * tab, give watchers a seat, and make sure there's someone to play against.
   */
  protected beginStart(byId: string, min = 2): void {
    this.requireHost(byId);
    this.requireBetweenRounds();
    for (const p of [...this.s.players]) {
      if (!p.cpu && !p.connected) this.removePlayer(p.id);
    }
    this.promoteSpectators();
    if (this.participants.length < min) throw new GameError("Need at least two players — add a CPU?");
  }

  protected promoteSpectators(): void {
    for (const p of this.s.players) {
      if (p.spectator && this.participants.length < this.maxPlayers) p.spectator = false;
    }
  }

  protected newPlayer(id: string, name: string, cpu: CpuLevel | null): S["players"][number] {
    const used = new Set(this.s.players.map((p) => p.color));
    const color = this.colors.find((c) => !used.has(c)) ?? this.colors[this.s.players.length % this.colors.length];
    return this.createPlayer({ id, name, color, cpu, connected: !cpu, spectator: false });
  }

  protected removePlayer(id: string): void {
    const s = this.s;
    s.players = s.players.filter((p) => p.id !== id);
    if (s.hostId === id) {
      const next = s.players.find((p) => !p.cpu && p.connected) ?? s.players.find((p) => !p.cpu);
      s.hostId = next?.id ?? "";
    }
    this.touch();
  }

  /** Host-only actions. If the host has dropped, whoever acts takes over. */
  protected requireHost(id: string): void {
    const s = this.s;
    if (s.hostId === id) return;
    const host = this.player(s.hostId);
    const me = this.player(id);
    if (me && !me.cpu && (!host || !this.io.isConnected(host.id))) {
      s.hostId = id;
      this.event(`${me.name} is now the host`);
      // Everyone hears about it, even if the action that asked then fails.
      this.touch();
      return;
    }
    throw new GameError("Only the host can do that");
  }

  protected requireBetweenRounds(): void {
    if (!this.betweenRounds()) throw new GameError("Wait for the round to end");
  }

  protected requirePhase(...phases: string[]): void {
    if (!phases.includes(this.s.phase)) throw new GameError("Not right now");
  }

  protected event(text: string): void {
    this.logs.push({ at: this.io.now(), kind: "event", text });
  }

  protected touch(): void {
    this.dirty = true;
    this.s.lastActive = this.io.now();
  }
}
