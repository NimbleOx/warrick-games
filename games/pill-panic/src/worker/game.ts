import {
  COUNTDOWN_MS,
  INTERMISSION_MS,
  MAX_PLAYERS,
  PLAYER_COLORS,
  TICK_MS,
  virusCount,
} from "../shared/constants";
import {
  DEFAULT_SETTINGS,
  SETTING_CHOICES,
  type ClientMsg,
  type CpuLevel,
  type GameState,
  type LogEntry,
  type PlayerState,
  type RoundSnap,
  type ServerMsg,
  type Settings,
  type Standing,
} from "../shared/protocol";
import { mulberry32, randomSeed, type Rng } from "../shared/rng";
import { Round } from "../shared/round";

export class GameError extends Error {}

export interface GameIO {
  now(): number;
  isConnected(playerId: string): boolean;
}

/** The round being played. Its bottles change every tick, so it lives in memory only. */
export interface Live {
  round: Round;
  rng: Rng;
}

const CPU_NAMES = ["Pip", "Fizz", "Dose", "Tonic", "Zinc", "Syrup", "Tablet", "Placebo", "Remedy", "Lozenge"];

export function newGameState(code: string, now: number): GameState {
  return {
    code,
    createdAt: now,
    lastActive: now,
    phase: "lobby",
    hostId: "",
    settings: { ...DEFAULT_SETTINGS },
    players: [],
    match: 0,
    round: null,
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
 * All the game rules, as plain state transitions. The Durable Object owns the sockets, storage
 * and the loop; this class only changes `s` and `live` and queues messages.
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

  bySlot(slot: number): PlayerState | undefined {
    return slot < 0 ? undefined : this.s.players.find((p) => p.slot === slot);
  }

  get participants(): PlayerState[] {
    return this.s.players.filter((p) => !p.spectator);
  }

  addHuman(rawName: string): PlayerState {
    const id = `p${this.s.nextPlayerNum++}`;
    const name = cleanName(rawName, `Player ${id.slice(1)}`);
    const p = this.newPlayer(id, name, null);
    if (this.participants.length >= MAX_PLAYERS) p.spectator = true;
    this.s.players.push(p);
    if (!this.s.hostId || !this.player(this.s.hostId)) this.s.hostId = id;
    if (p.spectator) this.event(`${name} is watching`);
    else if (this.s.phase === "playing") this.event(`${name} joined, and plays from the next round`);
    else this.event(`${name} joined`);
    this.touch();
    return p;
  }

  addCpu(byId: string, level: CpuLevel): void {
    this.requireHost(byId);
    this.requireBetweenMatches();
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
    this.requireBetweenMatches();
    const target = this.player(targetId);
    if (!target || targetId === byId) return false;
    this.removePlayer(targetId);
    this.event(`${target.name} was removed`);
    return !target.cpu;
  }

  leave(id: string): void {
    const p = this.player(id);
    if (!p) return;
    if (p.slot >= 0 && !this.s.round?.over) this.live?.round.quit(p.slot);
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
    this.requireBetweenMatches();
    const p = this.player(id);
    if (!p || !(PLAYER_COLORS as readonly string[]).includes(color)) return;
    const taken = this.s.players.find((o) => o.id !== id && o.color === color);
    if (taken) taken.color = p.color;
    p.color = color;
    this.touch();
  }

  updateSettings(byId: string, patch: Partial<Settings>): void {
    this.requireHost(byId);
    this.requireBetweenMatches();
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

  /** Start a match, from the lobby or from the last match's results. */
  start(byId: string): void {
    this.requireHost(byId);
    this.requireBetweenMatches();
    // Players who closed their tab between matches don't get a seat.
    for (const p of [...this.s.players]) {
      if (!p.cpu && !p.connected) this.removePlayer(p.id);
    }
    this.promoteSpectators();
    if (this.participants.length < 2) throw new GameError("Need at least two players — add a CPU?");
    this.s.match++;
    for (const p of this.s.players) {
      p.wins = 0;
      p.cleared = 0;
      p.sent = 0;
    }
    this.s.results = null;
    const { level, speed, wins } = this.s.settings;
    this.event(
      `Match ${this.s.match}: level ${level} (${virusCount(level)} germs), ${speed} speed, first to ${wins} round${wins === 1 ? "" : "s"}`,
    );
    this.startRound(1);
  }

  backToLobby(byId: string): void {
    this.requireHost(byId);
    if (this.s.phase !== "results") throw new GameError("Not right now");
    this.s.phase = "lobby";
    this.s.results = null;
    this.s.round = null;
    this.promoteSpectators();
    this.touch();
  }

  /** The room restarted and the round's bottles were lost: play it again. */
  recover(): void {
    const r = this.s.round;
    if (this.s.phase !== "playing" || this.live || !r) return;
    if (r.over) {
      this.startRound(r.n + 1);
      return;
    }
    this.event(`The server restarted, so round ${r.n} starts over`);
    this.startRound(r.n);
  }

  /** The loop is starting again after nobody was here: pick the round up where it stopped. */
  resume(): void {
    const r = this.s.round;
    if (this.s.phase !== "playing" || !this.live || !r || r.over) return;
    const now = this.io.now();
    const max = this.live.round.maxTick();
    if (Math.floor((now - r.goAt) / TICK_MS) > max + 30) {
      r.goAt = now - max * TICK_MS;
      this.touch();
    }
  }

  /** A player's inputs. */
  feed(id: string, msg: Extract<ClientMsg, { t: "in" }>): void {
    const p = this.player(id);
    const r = this.s.round;
    if (!p || p.slot < 0 || !this.live || !r || r.over) return;
    this.live.round.feed(p.slot, msg.e, msg.n, msg.k, msg.g, this.wall());
  }

  /** The player's browser lost track of its own bottle: send it ours with the next frame. */
  resyncOwn(id: string): void {
    const p = this.player(id);
    if (p && p.slot >= 0 && !this.s.round?.over) this.live?.round.resync(p.slot);
  }

  /** A browser (re)connected: its bottle starts over from the server's copy. */
  rejoin(id: string): void {
    const p = this.player(id);
    if (p && p.slot >= 0 && !this.s.round?.over) this.live?.round.rejoin(p.slot);
  }

  snapshot(): RoundSnap | null {
    const r = this.s.round;
    return this.live && r ? this.live.round.snapshot(r.n, r.goAt, this.who()) : null;
  }

  /** Player id by slot, for the round's snapshot. */
  private who(): (string | null)[] {
    const who: (string | null)[] = Array(MAX_PLAYERS).fill(null);
    for (const p of this.s.players) if (p.slot >= 0) who[p.slot] = p.id;
    return who;
  }

  /** Run the round: called by the room's loop. */
  tick(): void {
    const s = this.s;
    const r = s.round;
    if (s.phase !== "playing" || !r) return;
    if (r.over) {
      if (r.nextAt !== null && this.io.now() >= r.nextAt) this.startRound(r.n + 1);
      return;
    }
    const live = this.live;
    if (!live) return;
    live.round.step(this.wall(), (slot) => {
      const p = this.bySlot(slot);
      return !!p && (!!p.cpu || this.io.isConnected(p.id));
    });
    const frame = live.round.collect();
    if (frame) this.outbox.push(frame);
    if (live.round.outcome) this.finishRound();
  }

  private wall(): number {
    const r = this.s.round;
    return r ? Math.floor((this.io.now() - r.goAt) / TICK_MS) : -1;
  }

  private startRound(n: number): void {
    const s = this.s;
    this.promoteSpectators();
    for (const p of s.players) p.slot = -1;
    // Players who are offline sit this round out.
    const seated = this.participants.filter((p) => p.cpu || p.connected);
    if (seated.length < 2) return this.endMatch(null, "Not enough players left to carry on.");
    seated.forEach((p, i) => (p.slot = i));
    const rng = mulberry32(randomSeed());
    const seed = Math.floor(rng() * 0xffffffff) >>> 0;
    const { level, speed, aim } = s.settings;
    const round = new Round({ seed, level, speed, aim, seats: seated.map((p) => ({ slot: p.slot, cpu: p.cpu })) }, rng);
    this.live = { round, rng };
    s.phase = "playing";
    s.round = { n, seed, goAt: this.io.now() + COUNTDOWN_MS, level, speed, over: null, nextAt: null };
    this.outbox.push({ t: "snap", snap: round.snapshot(n, s.round.goAt, this.who()) });
    this.touch();
  }

  private finishRound(): void {
    const s = this.s;
    const r = s.round!;
    const round = this.live!.round;
    const o = round.outcome!;
    // Let the last frame show how the round ended.
    const frame = round.collect();
    if (frame) this.outbox.push(frame);

    const seated = s.players.filter((p) => p.slot >= 0);
    const winners = o.winners.map((slot) => this.bySlot(slot)).filter((p): p is PlayerState => !!p);
    for (const w of winners) w.wins++;
    const stats = seated.map((p) => {
      const st = round.stats(p.slot)!;
      p.cleared += st.cleared;
      p.sent += st.sent;
      return { id: p.id, ...st };
    });
    r.over = { winners: winners.map((p) => p.id), how: winners.length ? o.how : "draw", stats };

    const names = winners.map((p) => p.name).join(" and ");
    if (!winners.length) this.event(`Round ${r.n} is a draw`);
    else if (o.how === "cleared") this.event(`${names} cleared the bottle first and ${winners.length > 1 ? "share" : "takes"} round ${r.n}`);
    else this.event(`${names} is the last one standing and takes round ${r.n}`);

    // The match goes to the first to the target, as long as nobody is level with them.
    const target = s.settings.wins;
    const ranked = [...this.participants].sort((a, b) => b.wins - a.wins);
    const [top, second] = ranked;
    if (top && top.wins >= target && (!second || top.wins > second.wins)) {
      this.endMatch(top, "");
    } else {
      r.nextAt = this.io.now() + INTERMISSION_MS;
      this.touch();
    }
  }

  private endMatch(winner: PlayerState | null, note: string): void {
    const s = this.s;
    const standings: Standing[] = this.participants
      .map((p) => ({ id: p.id, name: p.name, color: p.color, cpu: !!p.cpu, wins: p.wins, cleared: p.cleared, sent: p.sent }))
      .sort((a, b) => b.wins - a.wins || b.cleared - a.cleared || b.sent - a.sent);
    s.results = { match: s.match, winnerId: winner?.id ?? null, rounds: s.round?.n ?? 0, note, standings };
    s.phase = "results";
    if (s.round && !s.round.over) s.round = null;
    if (winner) {
      winner.trophies++;
      this.event(`${winner.name} wins the match!`);
    } else if (note) {
      this.event(note);
    }
    for (const p of s.players) p.slot = -1;
    this.live = null;
    this.touch();
  }

  private promoteSpectators(): void {
    for (const p of this.s.players) {
      if (p.spectator && this.participants.length < MAX_PLAYERS) p.spectator = false;
    }
  }

  private newPlayer(id: string, name: string, cpu: CpuLevel | null): PlayerState {
    const used = new Set(this.s.players.map((p) => p.color));
    const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0];
    return { id, name, color, cpu, connected: !cpu, spectator: false, slot: -1, wins: 0, cleared: 0, sent: 0, trophies: 0 };
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

  private requireBetweenMatches(): void {
    if (this.s.phase === "playing") throw new GameError("Wait for the match to end");
  }

  private event(text: string): void {
    this.logs.push({ at: this.io.now(), kind: "event", text });
  }

  private touch(): void {
    this.dirty = true;
    this.s.lastActive = this.io.now();
  }
}
