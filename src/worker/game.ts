import {
  CASH_PER_DAMAGE,
  CASH_PER_KILL,
  CASH_SURVIVE,
  CASH_WIN,
  MAX_PLAYERS,
  PLAYER_COLORS,
  SCORE_PER_KILL,
  SCORE_PER_WIN,
  SHIELD_HP,
  START_HEALTH,
  THEME_COUNT,
  TICK_MS,
  WORLD_W,
} from "../shared/constants";
import {
  DEFAULT_SETTINGS,
  SETTING_CHOICES,
  rankPlayers,
  type Aim,
  type CpuLevel,
  type GameState,
  type LogEntry,
  type PlayerState,
  type ServerMsg,
  type Settings,
  type ShotMessage,
} from "../shared/protocol";
import { mulberry32, randInt, randomSeed, shuffle } from "../shared/rng";
import { launchFor, maxPowerFor } from "../shared/sim";
import { TERRAIN_STYLES, flattenPad, generateTerrain } from "../shared/terrain";
import { isShopId, isWeaponId, shopDef, weaponCount, type ShopId, type WeaponId } from "../shared/weapons";
import { worldFromState } from "../shared/world-state";
import { cpuShop, chooseCpuShot } from "./ai";

export class GameError extends Error {}

export interface GameIO {
  now(): number;
  isConnected(playerId: string): boolean;
}

const CPU_NAMES = ["Bert", "Ziggy", "Moe", "Pixel", "Dozer", "Rusty", "Boomer", "Clank", "Mortimer", "Spud"];
const RESOLVE_PAUSE_MS = 900;
const CPU_THINK_MS = 1400;
const DISCONNECTED_SKIP_MS = 4000;
const RECONNECT_GRACE_MS = 8000;
const ROUNDOVER_MS = 5000;
const SHOP_MS = 60000;

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
    terrain: [],
    theme: 0,
    wind: 0,
    turnOrder: [],
    turnPlayerId: null,
    turnDeadline: null,
    resolving: false,
    roundWinnerId: null,
    phaseDeadline: null,
    timer: null,
    shotCount: 0,
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
 * sockets, storage and alarms; this class only mutates `s` and queues messages.
 */
export class Game {
  /** Messages to broadcast once the current action is done. */
  outbox: ServerMsg[] = [];
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
    if (!p || p.cpu) return;
    p.connected = connected;
    const s = this.s;
    if (s.phase === "playing" && s.turnPlayerId === id && !s.resolving) {
      const now = this.io.now();
      if (connected) {
        s.turnDeadline = s.settings.turnSeconds ? now + s.settings.turnSeconds * 1000 : null;
        s.timer = s.turnDeadline ? { kind: "turn", at: s.turnDeadline } : null;
      } else {
        const at = Math.min(s.turnDeadline ?? Infinity, now + RECONNECT_GRACE_MS);
        s.turnDeadline = at;
        s.timer = { kind: "turn", at };
      }
    }
    if (s.phase === "shop" && !connected) this.maybeEndShop();
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
    const cashChanged = next.startCash !== this.s.settings.startCash;
    this.s.settings = next;
    if (cashChanged) for (const p of this.s.players) p.money = next.startCash;
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
    if (this.participants.length < 2) throw new GameError("Need at least two players — add a CPU?");
    for (const p of this.s.players) {
      p.money = this.s.settings.startCash;
      p.inventory = {};
      p.kills = p.wins = p.damage = p.score = 0;
      p.ready = false;
      p.tank = null;
    }
    this.s.round = 0;
    this.s.shotCount = 0;
    this.event(`Game on! ${this.s.settings.rounds} round${this.s.settings.rounds > 1 ? "s" : ""}.`);
    this.startRound();
  }

  backToLobby(byId: string): void {
    this.requireHost(byId);
    this.requirePhase("gameover");
    const s = this.s;
    s.phase = "lobby";
    s.round = 0;
    s.terrain = [];
    s.turnOrder = [];
    s.turnPlayerId = null;
    s.turnDeadline = null;
    s.roundWinnerId = null;
    s.phaseDeadline = null;
    s.timer = null;
    for (const p of s.players) {
      p.tank = null;
      p.ready = false;
      p.money = s.settings.startCash;
      p.inventory = {};
      if (p.spectator && this.participants.length < MAX_PLAYERS) p.spectator = false;
    }
    this.touch();
  }

  private startRound(): void {
    const s = this.s;
    const rng = mulberry32(randomSeed());
    s.round++;
    s.phase = "playing";
    s.roundWinnerId = null;
    s.phaseDeadline = null;

    const style = TERRAIN_STYLES[randInt(rng, 0, TERRAIN_STYLES.length - 1)];
    const heights = generateTerrain(rng, style);
    s.theme = randInt(rng, 0, THEME_COUNT - 1);
    s.wind = s.settings.maxWind ? randInt(rng, -s.settings.maxWind, s.settings.maxWind) : 0;

    const order = shuffle(rng, this.participants.map((p) => p.id));
    const margin = 50;
    const slot = (WORLD_W - margin * 2) / order.length;
    order.forEach((id, i) => {
      const p = this.player(id)!;
      const x = Math.round(margin + slot * (i + 0.5) + (rng() - 0.5) * slot * 0.4);
      const y = flattenPad(heights, x);
      let shield = 0;
      if ((p.inventory.shield ?? 0) > 0) {
        p.inventory.shield = p.inventory.shield! - 1;
        shield = SHIELD_HP;
      }
      p.tank = { x, y, health: START_HEALTH, alive: true, shield };
      const weapon = weaponCount(p.inventory, p.aim.weapon) > 0 ? p.aim.weapon : "baby_missile";
      p.aim = { angle: x < WORLD_W / 2 ? 60 : 120, power: 500, weapon };
      p.ready = false;
    });
    s.terrain = heights;
    s.turnOrder = order;
    this.event(`Round ${s.round} of ${s.settings.rounds}`);
    this.beginTurn(order[0]);
  }

  private beginTurn(id: string): void {
    const s = this.s;
    const p = this.player(id)!;
    const now = this.io.now();
    s.turnPlayerId = id;
    s.resolving = false;
    if (p.cpu) {
      s.turnDeadline = null;
      s.timer = { kind: "cpu", at: now + CPU_THINK_MS };
    } else if (!this.io.isConnected(id)) {
      s.turnDeadline = now + DISCONNECTED_SKIP_MS;
      s.timer = { kind: "turn", at: s.turnDeadline };
    } else if (s.settings.turnSeconds) {
      s.turnDeadline = now + s.settings.turnSeconds * 1000;
      s.timer = { kind: "turn", at: s.turnDeadline };
    } else {
      s.turnDeadline = null;
      s.timer = null;
    }
    this.touch();
  }

  private nextTurn(): void {
    const order = this.s.turnOrder;
    const idx = order.indexOf(this.s.turnPlayerId ?? "");
    for (let i = 1; i <= order.length; i++) {
      const id = order[(idx + i) % order.length];
      if (this.player(id)?.tank?.alive) return this.beginTurn(id);
    }
    this.roundOver(null);
  }

  aim(id: string, raw: Aim): void {
    const s = this.s;
    if (s.phase !== "playing" || s.resolving || s.turnPlayerId !== id) return;
    const p = this.player(id)!;
    const aim = this.cleanAim(p, raw);
    if (!aim) return;
    p.aim = aim;
    this.outbox.push({ t: "aim", id, aim });
  }

  fire(id: string, raw: Aim): void {
    const s = this.s;
    if (s.phase !== "playing" || s.resolving) throw new GameError("You can't fire right now");
    if (s.turnPlayerId !== id) throw new GameError("It's not your turn");
    const p = this.player(id)!;
    const aim = this.cleanAim(p, raw);
    if (!aim) throw new GameError("You don't have that weapon");
    this.resolveShot(p, aim);
  }

  private cleanAim(p: PlayerState, raw: Aim): Aim | null {
    if (!p.tank?.alive || !raw || !isWeaponId(String(raw.weapon))) return null;
    if (weaponCount(p.inventory, raw.weapon) <= 0) return null;
    const angle = clampInt(raw.angle, 0, 180);
    const power = clampInt(raw.power, 0, maxPowerFor(p.tank.health));
    return { angle, power, weapon: raw.weapon };
  }

  private resolveShot(p: PlayerState, aim: Aim): void {
    const s = this.s;
    const now = this.io.now();
    const tank = p.tank!;
    const shot: ShotMessage = {
      shooterId: p.id,
      weapon: aim.weapon,
      angle: aim.angle,
      power: aim.power,
      seed: randomSeed(),
      ...launchFor(tank, aim.angle, aim.power),
    };
    p.aim = aim;

    const world = worldFromState(s);
    world.fire(shot);
    world.runToEnd();

    if (aim.weapon !== "baby_missile") spend(p, aim.weapon);
    s.terrain = world.heights;
    for (const t of world.tanks) {
      const pl = this.player(t.id)!;
      pl.tank = { x: t.x, y: t.y, health: t.health, alive: t.alive, shield: t.shield };
      if (t.parachutes > 0) pl.inventory.parachute = t.parachutes;
      else delete pl.inventory.parachute;
    }
    for (const ev of world.events) {
      if (ev.type === "damage" && ev.by !== ev.id) {
        const a = this.player(ev.by);
        if (a) {
          a.damage += ev.amount;
          a.score += ev.amount;
          a.money += ev.amount * CASH_PER_DAMAGE;
        }
      } else if (ev.type === "kill") {
        const victim = this.player(ev.id)!;
        const a = this.player(ev.by);
        if (a && ev.by !== ev.id) {
          a.kills++;
          a.score += SCORE_PER_KILL;
          a.money += CASH_PER_KILL;
          this.event(`💥 ${a.name} destroyed ${victim.name}`);
        } else {
          this.event(`💥 ${victim.name} blew themselves up`);
        }
      }
    }

    s.shotCount++;
    s.resolving = true;
    s.turnDeadline = null;
    s.timer = { kind: "resolve", at: now + world.tick * TICK_MS + RESOLVE_PAUSE_MS };
    this.touch();
    this.outbox.push({ t: "shot", shot, state: s, now });
  }

  private afterShot(): void {
    this.s.resolving = false;
    const alive = this.participants.filter((p) => p.tank?.alive);
    if (alive.length <= 1) this.roundOver(alive[0] ?? null);
    else this.nextTurn();
  }

  private roundOver(winner: PlayerState | null): void {
    const s = this.s;
    s.phase = "roundover";
    s.turnPlayerId = null;
    s.turnDeadline = null;
    s.resolving = false;
    for (const p of this.participants) if (p.tank?.alive) p.money += CASH_SURVIVE;
    if (winner) {
      winner.wins++;
      winner.money += CASH_WIN;
      winner.score += SCORE_PER_WIN;
      this.event(`🏆 ${winner.name} wins round ${s.round}`);
    } else {
      this.event(`Round ${s.round} is a draw — nobody survived`);
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
    s.phase = "shop";
    s.phaseDeadline = this.io.now() + SHOP_MS;
    s.timer = { kind: "shop", at: s.phaseDeadline };
    for (const p of this.participants) {
      p.ready = false;
      if (p.cpu) {
        cpuShop(p);
        p.ready = true;
      }
    }
    this.touch();
    this.maybeEndShop();
  }

  buy(id: string, item: ShopId, qty: 1 | -1): void {
    this.requirePhase("shop");
    const p = this.player(id);
    if (!p || p.spectator || !isShopId(String(item)) || item === "baby_missile") {
      throw new GameError("Can't buy that");
    }
    const def = shopDef(item);
    const have = p.inventory[item] ?? 0;
    if (qty === 1) {
      if (p.money < def.price) throw new GameError("Not enough cash");
      p.money -= def.price;
      p.inventory[item] = have + def.bundle;
    } else {
      if (have < def.bundle) throw new GameError("Nothing to sell");
      p.money += def.price;
      if (have - def.bundle > 0) p.inventory[item] = have - def.bundle;
      else delete p.inventory[item];
    }
    this.touch();
  }

  setReady(id: string, ready: boolean): void {
    this.requirePhase("shop");
    const p = this.player(id);
    if (!p || p.spectator) return;
    p.ready = !!ready;
    this.touch();
    this.maybeEndShop();
  }

  private maybeEndShop(): void {
    if (this.s.phase !== "shop") return;
    const waiting = this.participants.filter((p) => !p.cpu && this.io.isConnected(p.id) && !p.ready);
    if (waiting.length === 0) this.startRound();
  }

  // ---------------------------------------------------------------- timers

  onTimer(): void {
    const s = this.s;
    const t = s.timer;
    if (!t || this.io.now() < t.at - 25) return;
    s.timer = null;
    switch (t.kind) {
      case "cpu": {
        const p = this.player(s.turnPlayerId ?? "");
        if (p?.cpu && p.tank?.alive && s.phase === "playing" && !s.resolving) {
          this.resolveShot(p, chooseCpuShot(s, p, p.cpu, mulberry32(randomSeed())));
        } else {
          this.nextTurn();
        }
        break;
      }
      case "turn": {
        const p = this.player(s.turnPlayerId ?? "");
        if (s.phase === "playing" && !s.resolving && p) {
          this.event(p.connected ? `⏱ ${p.name} ran out of time` : `${p.name} is away — skipping`);
          this.nextTurn();
        }
        break;
      }
      case "resolve":
        this.afterShot();
        break;
      case "roundover":
        this.afterRoundOver();
        break;
      case "shop":
        if (s.phase === "shop") this.startRound();
        break;
    }
    this.touch();
  }

  // ---------------------------------------------------------------- helpers

  private newPlayer(id: string, name: string, cpu: CpuLevel | null, spectator: boolean): PlayerState {
    const used = new Set(this.s.players.map((p) => p.color));
    const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[this.s.players.length % PLAYER_COLORS.length];
    return {
      id,
      name,
      color,
      cpu,
      connected: true,
      spectator,
      money: this.s.settings.startCash,
      inventory: {},
      kills: 0,
      wins: 0,
      damage: 0,
      score: 0,
      ready: false,
      tank: null,
      aim: { angle: 60, power: 500, weapon: "baby_missile" },
    };
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

function spend(p: PlayerState, weapon: WeaponId): void {
  const n = (p.inventory[weapon] ?? 0) - 1;
  if (n > 0) p.inventory[weapon] = n;
  else delete p.inventory[weapon];
}

function clampInt(v: unknown, lo: number, hi: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
