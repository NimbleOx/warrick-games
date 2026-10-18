import {
  CASH_PER_DAMAGE,
  CASH_PER_KILL,
  CASH_SURVIVE,
  CASH_WIN,
  DRAW_TURNS_EACH,
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
  powerCap,
  quietLimit,
  quietTurnsEach,
  rankPlayers,
  type Aim,
  type GameState,
  type PlayerState,
  type ServerMsg,
  type Settings,
  type ShotMessage,
} from "../shared/protocol";
import type { BasePlayer } from "@warrick/kit/shared/protocol";
import { mulberry32, randInt, randomSeed, shuffle } from "@warrick/kit/shared/rng";
import { GameError, Lobby, baseState } from "@warrick/kit/worker/lobby";
import { type ClockRules, startTurnClock, turnHolderBack, turnHolderLeft, turnTimeUp } from "@warrick/kit/worker/turns";
import { launchFor } from "../shared/sim";
import { TERRAIN_STYLES, flattenPad, generateTerrain } from "../shared/terrain";
import { isShopId, isWeaponId, shopDef, weaponCount, type ShopId, type WeaponId } from "../shared/weapons";
import { worldFromState } from "../shared/world-state";
import { cpuShop, chooseCpuShot } from "./ai";

export { GameError, type GameIO } from "@warrick/kit/worker/lobby";

const CPU_NAMES = ["Bert", "Ziggy", "Moe", "Pixel", "Dozer", "Rusty", "Boomer", "Clank", "Mortimer", "Spud"];
const RESOLVE_PAUSE_MS = 900;
const CPU_THINK_MS = 1400;
const DISCONNECTED_SKIP_MS = 4000;
const RECONNECT_GRACE_MS = 8000;
const ROUNDOVER_MS = 5000;
const SHOP_MS = 60000;

/** The turn clock: whoever drops on their turn has RECONNECT_GRACE_MS to come back. */
const CLOCK: ClockRules = { awayMs: RECONNECT_GRACE_MS };
/** A turn that comes round to someone who's already away is skipped sooner. */
const SKIP_CLOCK: ClockRules = { awayMs: DISCONNECTED_SKIP_MS };

export function newGameState(code: string, now: number): GameState {
  return {
    ...baseState(code, now, DEFAULT_SETTINGS),
    round: 0,
    terrain: [],
    theme: 0,
    wind: 0,
    turnOrder: [],
    turnPlayerId: null,
    clockEnd: null,
    turnDeadline: null,
    resolving: false,
    roundWinnerId: null,
    phaseDeadline: null,
    timer: null,
    shotCount: 0,
    quietTurns: 0,
    suddenDeath: false,
  };
}

/**
 * Crater Club's rules on top of the kit's lobby: turns, shots, rounds, the shop and the timers
 * that drive them. The lobby is only open in the "lobby" phase, and a finished game sits in
 * "gameover" until the host takes everyone back.
 */
export class Game extends Lobby<GameState, ServerMsg> {
  protected readonly choices = SETTING_CHOICES;
  protected readonly cpuNames = CPU_NAMES;
  protected readonly finishedPhase = "gameover";

  protected betweenRounds(): boolean {
    return this.s.phase === "lobby";
  }

  protected createPlayer(base: BasePlayer): PlayerState {
    return {
      ...base,
      // CPUs count as connected: an "away" player's turns are skipped.
      connected: true,
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

  // ---------------------------------------------------------------- players

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
    // A second tab, or a hello from someone already here, changes nothing.
    if (!p || p.cpu || p.connected === connected) return;
    p.connected = connected;
    const s = this.s;
    if (s.phase === "playing" && s.turnPlayerId === id && !s.resolving) {
      // Back, you get the clock you had (never more); away, your turn ends soon.
      const now = this.io.now();
      this.armTurn(connected ? turnHolderBack(s, CLOCK, now) : turnHolderLeft(s, CLOCK, now));
    }
    if (s.phase === "shop") this.armShop();
    this.touch();
  }

  updateSettings(byId: string, patch: Partial<Settings>): void {
    const cash = this.s.settings.startCash;
    super.updateSettings(byId, patch);
    if (this.s.settings.startCash !== cash) for (const p of this.s.players) p.money = this.s.settings.startCash;
  }

  // ---------------------------------------------------------------- match flow

  start(byId: string): void {
    // Players who closed their tab in the lobby don't hold up the game, and watchers get their seats.
    this.beginStart(byId);
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
    // Starting cash is spent before round 1, as in the original.
    if (this.s.settings.startCash > 0) this.openShop();
    else this.startRound();
  }

  protected resetForLobby(): void {
    const s = this.s;
    s.round = 0;
    s.terrain = [];
    s.turnOrder = [];
    s.turnPlayerId = null;
    s.clockEnd = s.turnDeadline = null;
    s.roundWinnerId = null;
    s.phaseDeadline = null;
    s.timer = null;
    s.quietTurns = 0;
    s.suddenDeath = false;
    for (const p of s.players) {
      p.tank = null;
      p.ready = false;
      p.money = s.settings.startCash;
      p.inventory = {};
    }
  }

  private startRound(): void {
    const s = this.s;
    const rng = mulberry32(randomSeed());
    const order = this.turnOrderFor(rng);
    s.round++;
    s.phase = "playing";
    s.roundWinnerId = null;
    s.phaseDeadline = null;
    s.quietTurns = 0;
    s.suddenDeath = false;

    const style = TERRAIN_STYLES[randInt(rng, 0, TERRAIN_STYLES.length - 1)];
    const heights = generateTerrain(rng, style);
    s.theme = randInt(rng, 0, THEME_COUNT - 1);
    s.wind = s.settings.maxWind ? randInt(rng, -s.settings.maxWind, s.settings.maxWind) : 0;

    // Where the tanks stand has nothing to do with when they fire. (Lined up in turn order, the
    // first to fire always stood at an end of the map, where fewer tanks are near enough to aim
    // at it, and won far more than its share.)
    const lineup = shuffle(rng, [...order]);
    const margin = 50;
    const slot = (WORLD_W - margin * 2) / lineup.length;
    lineup.forEach((id, i) => {
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
      p.lastShot = null;
    });
    s.terrain = heights;
    s.turnOrder = order;
    this.event(`Round ${s.round} of ${s.settings.rounds}: ${this.player(order[0])!.name} fires first`);
    this.beginTurn(order[0]);
  }

  /**
   * Firing first is worth a lot to a good shot, who often hits before anyone can reply. So it
   * passes round the players, one round to the next, and nobody starts more often than anybody
   * else. The first round's starter is drawn at random, and so is the order of the rest.
   */
  private turnOrderFor(rng: () => number): string[] {
    const ids = this.participants.map((p) => p.id);
    const last = this.s.round > 0 ? ids.indexOf(this.s.turnOrder[0] ?? "") : -1;
    const first = last >= 0 ? ids[(last + 1) % ids.length] : ids[randInt(rng, 0, ids.length - 1)];
    const rest = ids.filter((id) => id !== first);
    return [first, ...shuffle(rng, rest)];
  }

  private beginTurn(id: string): void {
    const s = this.s;
    const p = this.player(id)!;
    const now = this.io.now();
    s.turnPlayerId = id;
    s.resolving = false;
    if (p.cpu) {
      s.clockEnd = s.turnDeadline = null;
      s.timer = { kind: "cpu", at: now + CPU_THINK_MS };
    } else {
      const here = this.io.isConnected(id);
      this.armTurn(startTurnClock(s, here ? CLOCK : SKIP_CLOCK, now, s.settings.turnSeconds * 1000, here));
    }
    this.touch();
  }

  /** The timer for a human's turn: it ends at `at`, or never. */
  private armTurn(at: number | null): void {
    this.s.timer = at === null ? null : { kind: "turn", at };
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
    if (!p.tank?.alive || !raw || typeof raw.weapon !== "string" || !isWeaponId(raw.weapon)) return null;
    if (weaponCount(p.inventory, raw.weapon) <= 0) return null;
    const angle = clampInt(raw.angle, 0, 180);
    const power = clampInt(raw.power, 0, powerCap(this.s, p.tank));
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
    let hurt = false;
    for (const ev of world.events) {
      if (ev.type === "damage" || ev.type === "shield") hurt = true;
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
    s.quietTurns = hurt ? 0 : (s.quietTurns ?? 0) + 1;
    s.resolving = true;
    s.clockEnd = s.turnDeadline = null;
    s.timer = { kind: "resolve", at: now + world.tick * TICK_MS + RESOLVE_PAUSE_MS };
    this.touch();
    this.outbox.push({ t: "shot", shot, state: s, now });
  }

  private afterShot(): void {
    this.s.resolving = false;
    const alive = this.participants.filter((p) => p.tank?.alive);
    if (alive.length <= 1) this.roundOver(alive[0] ?? null);
    else this.endTurn();
  }

  /**
   * A turn is over. Too many in a row with nobody hurt (tanks that can't reach each other, or
   * players who won't fire) bring on sudden death, which lifts the power caps that damaged tanks
   * fire under. If that doesn't break the stalemate either, the round is a draw.
   */
  private endTurn(): void {
    const s = this.s;
    if ((s.quietTurns ?? 0) >= quietLimit(s)) {
      if (s.suddenDeath) return this.roundOver(null);
      this.event(`💀 Sudden death! Nobody was hurt in ${quietTurnsEach(s)} turns each, so damaged tanks fire at full power now`);
      s.suddenDeath = true;
      s.quietTurns = 0;
      this.event(`If nobody is hurt in the next ${DRAW_TURNS_EACH} turns each, round ${s.round} is a draw`);
    }
    this.nextTurn();
  }

  private roundOver(winner: PlayerState | null): void {
    const s = this.s;
    s.phase = "roundover";
    s.turnPlayerId = null;
    s.clockEnd = s.turnDeadline = null;
    s.resolving = false;
    for (const p of this.participants) if (p.tank?.alive) p.money += CASH_SURVIVE;
    if (winner) {
      winner.wins++;
      winner.money += CASH_WIN;
      winner.score += SCORE_PER_WIN;
      this.event(`🏆 ${winner.name} wins round ${s.round}`);
    } else if (this.participants.some((p) => p.tank?.alive)) {
      this.event(`Round ${s.round} is a draw — nobody was hurt in ${DRAW_TURNS_EACH} turns each of sudden death`);
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
    this.openShop();
  }

  /** Arms dealer: before the first round (if there's cash to spend) and between rounds. */
  private openShop(): void {
    const s = this.s;
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
    if (!p || p.spectator || typeof item !== "string" || !isShopId(item) || item === "baby_missile") {
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

  /** The players here who are shopping. */
  private get shoppers(): PlayerState[] {
    return this.participants.filter((p) => !p.cpu && this.io.isConnected(p.id));
  }

  /** The shop closes early once everyone here is ready. With nobody here, it waits for its time. */
  private maybeEndShop(): void {
    if (this.s.phase !== "shop") return;
    const here = this.shoppers;
    if (here.length > 0 && here.every((p) => p.ready)) this.startRound();
  }

  /**
   * Someone came or went while shopping. Going never closes the shop at once: it may only be a
   * reload. If everyone still here is ready, it closes once the one who went has had as long to
   * come back as a dropped turn gets.
   */
  private armShop(): void {
    const s = this.s;
    const here = this.shoppers;
    const end = s.phaseDeadline ?? this.io.now();
    const waitingOnAway = here.length > 0 && here.every((p) => p.ready) && this.participants.some((p) => !p.cpu && !p.ready);
    s.timer = { kind: "shop", at: waitingOnAway ? Math.min(end, this.io.now() + RECONNECT_GRACE_MS) : end };
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
        if (s.phase !== "playing" || s.resolving || !p) break;
        // Not yet, or noticed long after (the room was empty or restarting): there's time to come back.
        if (!turnTimeUp(s, CLOCK, this.io.now())) {
          this.armTurn(s.turnDeadline);
          break;
        }
        this.event(p.connected ? `⏱ ${p.name} ran out of time` : `${p.name} is away — skipping`);
        s.quietTurns = (s.quietTurns ?? 0) + 1;
        this.endTurn();
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
