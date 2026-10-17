import { Match } from "../shared/ai";
import { Arena, arenaSize, type ArenaEvent } from "../shared/arena";
import { MAX_PLAYERS, PLAYER_COLORS, THEME_COUNT } from "../shared/constants";
import {
  CRATE_DENSITY,
  DEFAULT_SETTINGS,
  ITEM_RATE,
  SETTING_CHOICES,
  rankPlayers,
  type CpuLevel,
  type GameState,
  type LogEntry,
  type PlayerState,
  type Settings,
} from "../shared/protocol";
import { mulberry32, randInt, randomSeed } from "../shared/rng";

export class GameError extends Error {}

export interface GameIO {
  now(): number;
  isConnected(playerId: string): boolean;
  /** The live round, kept in memory by the room. */
  match: Match | null;
}

const CPU_NAMES = ["Fuse", "Blinky", "Kaboom", "Pixel", "Dynamo", "Sparky", "Boomer", "Wick", "Cinder", "Pop"];
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
 * The rules around the rounds: lobby, settings, starting and scoring rounds.
 * The Durable Object owns the sockets, storage, alarm and tick loop; this class
 * only mutates `s`, swaps the live match, and queues log lines.
 */
export class Game {
  logs: LogEntry[] = [];
  dirty = false;

  constructor(
    public s: GameState,
    private io: GameIO,
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

  // ---------------------------------------------------------------- match flow

  start(byId: string): void {
    this.requireHost(byId);
    this.requirePhase("lobby");
    // Players who closed their tab in the lobby don't hold up the game.
    for (const p of [...this.s.players]) {
      if (!p.cpu && !p.connected) this.removePlayer(p.id);
    }
    if (this.participants.length < 2) throw new GameError("Need at least two bombers — add a CPU?");
    for (const p of this.s.players) {
      p.wins = p.kills = p.deaths = p.items = 0;
      p.inRound = false;
    }
    this.s.round = 0;
    const n = this.s.settings.wins;
    this.event(`Game on! First to ${n} win${n > 1 ? "s" : ""}.`);
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
    this.io.match = null;
    for (const p of s.players) {
      p.inRound = false;
      if (p.spectator && this.participants.length < MAX_PLAYERS) p.spectator = false;
    }
    this.touch();
  }

  private startRound(): void {
    const s = this.s;
    // Bombers whose players have gone sit the round out rather than standing there as targets.
    const roster = this.participants.filter((p) => p.cpu || p.connected);
    if (roster.length < 2) {
      this.event("Not enough bombers left to play on");
      this.gameOver();
      return;
    }
    const seed = randomSeed();
    const rng = mulberry32(seed);
    s.round++;
    s.phase = "playing";
    s.roundWinnerId = null;
    s.phaseDeadline = null;
    s.timer = null;
    for (const p of s.players) p.inRound = roster.includes(p);

    const arena = new Arena(
      rng,
      roster.map((p) => p.id),
      {
        ...arenaSize(roster.length),
        crates: CRATE_DENSITY[s.settings.crates],
        items: ITEM_RATE[s.settings.items],
        skulls: s.settings.skulls,
        hurryMs: s.settings.hurrySeconds ? s.settings.hurrySeconds * 1000 : null,
        theme: randInt(rng, 0, THEME_COUNT - 1),
      },
    );
    const cpus = roster.filter((p) => p.cpu).map((p) => ({ id: p.id, level: p.cpu! }));
    this.io.match = new Match(arena, cpus, rng);
    this.event(`Round ${s.round}`);
    this.touch();
  }

  /** The room lost its in-memory round (the object restarted): deal a fresh one. */
  restartRound(): void {
    if (this.s.phase !== "playing" || this.io.match) return;
    this.s.round = Math.max(0, this.s.round - 1);
    this.event("The round was interrupted — starting it again");
    this.startRound();
  }

  /** Narrate what happened in the arena this tick. */
  onArenaEvents(events: ArenaEvent[]): void {
    for (const ev of events) {
      if (ev.e === "die") {
        const victim = this.player(ev.id);
        if (!victim) continue;
        const killer = ev.by ? this.player(ev.by) : undefined;
        if (!ev.by) this.event(`🧱 ${victim.name} got squashed`);
        else if (ev.by === ev.id) this.event(`💥 ${victim.name} blew themselves up`);
        else if (killer) this.event(`💥 ${killer.name} blew up ${victim.name}`);
      } else if (ev.e === "hurry") {
        this.event("⏰ Hurry up! The walls are closing in");
      }
    }
  }

  /** The arena has a result: score the round. */
  roundOver(): void {
    const arena = this.io.match?.arena;
    if (this.s.phase !== "playing" || !arena?.result) return;
    const s = this.s;
    for (const ap of arena.players) {
      const p = this.player(ap.id);
      if (!p) continue;
      p.kills += ap.kills;
      p.items += ap.items;
      if (!ap.alive) p.deaths++;
    }
    const winner = this.player(arena.result.winner ?? "");
    if (winner) {
      winner.wins++;
      this.event(`🏆 ${winner.name} wins round ${s.round}`);
    } else {
      this.event(`Round ${s.round} is a draw`);
    }
    s.phase = "roundover";
    s.roundWinnerId = winner?.id ?? null;
    s.phaseDeadline = this.io.now() + ROUNDOVER_MS;
    s.timer = { kind: "roundover", at: s.phaseDeadline };
    this.touch();
  }

  private afterRoundOver(): void {
    const champion = this.participants.find((p) => p.wins >= this.s.settings.wins);
    if (champion) this.gameOver();
    else this.startRound();
  }

  private gameOver(): void {
    const s = this.s;
    s.phase = "gameover";
    s.phaseDeadline = null;
    s.timer = null;
    this.io.match = null;
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
    if (t.kind === "roundover" && s.phase === "roundover") this.afterRoundOver();
    this.touch();
  }

  // ---------------------------------------------------------------- helpers

  private newPlayer(id: string, name: string, cpu: CpuLevel | null, spectator: boolean): PlayerState {
    const used = new Set(this.s.players.map((p) => p.color));
    const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[this.s.players.length % PLAYER_COLORS.length];
    return { id, name, color, cpu, connected: true, spectator, wins: 0, kills: 0, deaths: 0, items: 0, inRound: false };
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
