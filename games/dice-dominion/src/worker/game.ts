import type { BasePlayer } from "@warrick/kit/shared/protocol";
import { mulberry32, randomSeed, shuffle } from "@warrick/kit/shared/rng";
import { GameError, Lobby, baseState } from "@warrick/kit/worker/lobby";
import { cpuAttack } from "../shared/ai";
import { CPU_GAP_FAST_MS, CPU_GAP_MS, dropMs } from "../shared/constants";
import { generateMap } from "../shared/map";
import {
  DEFAULT_SETTINGS,
  SETTING_CHOICES,
  type GameState,
  type PlayerState,
  type ServerMsg,
} from "../shared/protocol";
import {
  applyAttack,
  attackProblem,
  largestGroup,
  reinforce,
  rollDice,
  seatBonus,
  setupBoard,
  territoryCount,
  winnerSeat,
} from "../shared/rules";

export { GameError, type GameIO } from "@warrick/kit/worker/lobby";

const CPU_NAMES = ["Duke", "Baron", "Countess", "Marquis", "Earl", "Viscount", "Squire", "Regent", "Tsar", "Shogun"];
/** A player who isn't connected loses their turn after this long. */
const AWAY_MS = 5000;
/** Someone back from a dropped connection mid-turn gets at least this long on the clock. */
const BACK_MIN_MS = 5000;
/** The winner's banner, before the standings. */
const FINISH_MS = 3500;

export function newGameState(code: string, now: number): GameState {
  return {
    ...baseState(code, now, DEFAULT_SETTINGS),
    map: null,
    mapId: 0,
    owner: [],
    dice: [],
    order: [],
    turn: -1,
    round: 0,
    turnNo: 0,
    attackNo: 0,
    turnCaptures: 0,
    turnDeadline: null,
    clockEnd: null,
    timer: null,
    knockedOut: [],
    winnerId: null,
  };
}

/**
 * Dice Dominion's rules on top of the kit's lobby: turns, attacks, the end-of-turn dice and
 * the timers that drive them. The lobby is only open in the "lobby" phase, and a finished
 * game sits in "gameover" until the host takes everyone back.
 */
export class Game extends Lobby<GameState, ServerMsg> {
  protected readonly choices = SETTING_CHOICES;
  protected readonly cpuNames = CPU_NAMES;
  protected readonly finishedPhase = "gameover";
  /** This action started a game, so its state message carries the new map. */
  private mapChanged = false;
  private stateQueued = false;

  protected betweenRounds(): boolean {
    return this.s.phase === "lobby";
  }

  protected createPlayer(base: BasePlayer): PlayerState {
    return { ...base, seat: -1, reserve: 0, outRound: null, standIn: false, captures: 0, attacks: 0, wins: 0, peak: 0 };
  }

  /**
   * Every change goes out as one state message at the end of the action, without the map
   * unless this action made a new one; the welcome carries the full state. The room skips its
   * own state message when one in the outbox carries "state". It's a getter so it sends the
   * state as it is when the room sends it, after the action, and after any attack or dice
   * events the action queued before it.
   */
  protected touch(): void {
    super.touch();
    if (this.stateQueued) return;
    this.stateQueued = true;
    const game = this;
    this.outbox.push({
      t: "state",
      now: this.io.now(),
      get state() {
        return game.view();
      },
    });
  }

  /** The state as state messages send it. */
  view(): GameState {
    return { ...this.s, map: this.mapChanged ? this.s.map : null };
  }

  // ---------------------------------------------------------------- players

  /** Leaving mid-game leaves your territories behind; the host can hand them to a CPU. */
  leave(id: string): void {
    const p = this.player(id);
    if (!p) return;
    if (this.s.phase === "lobby" || p.seat < 0) {
      this.removePlayer(id);
      this.event(`${p.name} left`);
    } else {
      this.event(`${p.name} left the game`);
      this.setConnected(id, false);
    }
  }

  setConnected(id: string, connected: boolean): void {
    const p = this.player(id);
    if (!p) return;
    const s = this.s;
    if (p.standIn && connected) {
      // Back from being away: they take their seat back from the CPU.
      p.cpu = null;
      p.standIn = false;
      p.connected = false;
      this.event(`${p.name} is back and takes over from the CPU`);
    }
    if (p.cpu || p.connected === connected) return;
    super.setConnected(id, connected);
    if (!this.isTurnOf(id)) return;
    const now = this.io.now();
    if (connected) {
      s.clockEnd = s.clockEnd === null ? this.clock() : Math.max(s.clockEnd, now + BACK_MIN_MS);
      s.turnDeadline = s.clockEnd;
      s.timer = s.clockEnd ? { kind: "turn", at: s.clockEnd } : null;
    } else {
      s.turnDeadline = Math.min(s.clockEnd ?? Infinity, now + AWAY_MS);
      s.timer = { kind: "turn", at: s.turnDeadline };
    }
    this.touch();
  }

  /** Host only: a CPU plays for a player who isn't here, until they come back. */
  takeover(byId: string, targetId: string): void {
    this.requireHost(byId);
    this.requirePhase("playing");
    const s = this.s;
    const p = this.player(targetId);
    if (!p || p.cpu || p.seat < 0 || p.outRound !== null) throw new GameError("There's no seat to hand over");
    if (this.io.isConnected(p.id)) throw new GameError(`${p.name} is still here`);
    p.cpu = "normal";
    p.standIn = true;
    this.event(`A CPU takes over for ${p.name}`);
    if (this.isTurnOf(p.id)) {
      s.turnDeadline = s.clockEnd = null;
      s.timer = { kind: "cpu", at: this.io.now() + this.cpuGap() };
    }
    this.touch();
  }

  /** Host only, any time: CPUs attack without pausing. */
  setFast(byId: string, on: boolean): void {
    this.requireHost(byId);
    this.s.settings.fastCpus = !!on;
    this.touch();
  }

  /** A client without the current map asks for the full state. */
  sync(id: string): void {
    this.direct.push({ pid: id, msg: { t: "state", state: this.s, now: this.io.now() } });
  }

  // ---------------------------------------------------------------- game flow

  start(byId: string): void {
    this.beginStart(byId);
    const s = this.s;
    const seed = randomSeed();
    const rng = mulberry32(seed);
    const order = shuffle(rng, this.participants.map((p) => p.id));
    const size = s.settings.size;
    const map = generateMap(seed, order.length * size);
    const bonus = seatBonus(order.length, size);
    const board = setupBoard(rng, map.adj.length, order.length, size * 2, bonus);
    s.map = map;
    s.mapId = seed;
    s.owner = board.owner;
    s.dice = board.dice;
    s.order = order;
    s.round = 1;
    s.turnNo = 0;
    s.attackNo = 0;
    s.knockedOut = [];
    s.winnerId = null;
    for (const p of s.players) {
      Object.assign(p, { seat: order.indexOf(p.id), reserve: 0, outRound: null, captures: 0, attacks: 0, wins: 0, peak: 0 });
      if (p.seat >= 0) p.peak = territoryCount(s.owner, p.seat);
    }
    s.phase = "playing";
    this.mapChanged = true;
    this.event(`Game on! ${order.length} players, ${map.adj.length} territories. Take them all.`);
    const extras = order.map((id, seat) => (bonus[seat] ? `${this.player(id)!.name} +${bonus[seat]}` : "")).filter(Boolean);
    if (extras.length) this.event(`Later turns start with extra dice: ${extras.join(", ")}`);
    this.beginTurn(0);
  }

  protected resetForLobby(): void {
    const s = this.s;
    Object.assign(s, { map: null, mapId: 0, owner: [], dice: [], order: [], turn: -1, round: 0, turnDeadline: null, clockEnd: null, timer: null, knockedOut: [], winnerId: null });
    for (const p of s.players) {
      Object.assign(p, { seat: -1, reserve: 0, outRound: null, captures: 0, attacks: 0, wins: 0, peak: 0 });
      if (p.standIn) {
        p.cpu = null;
        p.standIn = false;
        p.connected = this.io.isConnected(p.id);
      }
    }
  }

  /** A human attacks. */
  attack(id: string, from: number, to: number): void {
    const s = this.s;
    const p = this.requireTurn(id);
    this.doAttack(p, from, to);
    if (!s.winnerId) {
      s.clockEnd = this.clock();
      s.turnDeadline = s.clockEnd;
      s.timer = s.clockEnd ? { kind: "turn", at: s.clockEnd } : null;
    }
    this.touch();
  }

  /** A human ends their turn. */
  endTurn(id: string): void {
    this.requireTurn(id);
    this.finishTurn();
  }

  onTimer(): void {
    const s = this.s;
    const t = s.timer;
    if (!t || this.io.now() < t.at - 25) return;
    s.timer = null;
    const p = this.seatPlayer(s.turn);
    switch (t.kind) {
      case "turn":
        if (s.phase === "playing" && p && !s.winnerId) {
          this.event(this.io.isConnected(p.id) ? `⏱ ${p.name} ran out of time` : `${p.name} is away, so their turn ends`);
          this.finishTurn();
        }
        break;
      case "cpu":
        if (s.phase === "playing" && p?.cpu && !s.winnerId) this.cpuStep(p);
        break;
      case "drop":
        if (s.phase === "playing") this.nextTurn();
        break;
      case "finish":
        this.gameOver();
        break;
    }
    this.touch();
  }

  // ---------------------------------------------------------------- internals

  private seatPlayer(seat: number): PlayerState | undefined {
    return this.player(this.s.order[seat] ?? "");
  }

  /** It's this player's turn and they can act: not while the dice drop or the game is won. */
  private isTurnOf(id: string): boolean {
    const s = this.s;
    return s.phase === "playing" && s.order[s.turn] === id && !s.winnerId && s.timer?.kind !== "drop";
  }

  private requireTurn(id: string): PlayerState {
    const s = this.s;
    const p = this.player(id);
    if (s.phase !== "playing" || !p || p.seat < 0) throw new GameError("You're not in this game");
    if (p.outRound !== null) throw new GameError("You're out of this game");
    if (s.winnerId) throw new GameError("The game is over");
    if (s.order[s.turn] !== id) throw new GameError(`It's ${this.seatPlayer(s.turn)?.name ?? "someone else"}'s turn`);
    if (s.timer?.kind === "drop") throw new GameError("Your turn is over");
    if (p.cpu) throw new GameError("A CPU is playing your seat");
    return p;
  }

  /** The turn clock for a human starting to think now. */
  private clock(): number | null {
    const secs = this.s.settings.turnSeconds;
    return secs ? this.io.now() + secs * 1000 : null;
  }

  private cpuGap(): number {
    return this.s.settings.fastCpus ? CPU_GAP_FAST_MS : CPU_GAP_MS;
  }

  private beginTurn(seat: number): void {
    const s = this.s;
    const p = this.seatPlayer(seat)!;
    const now = this.io.now();
    s.turn = seat;
    s.turnNo++;
    s.turnCaptures = 0;
    if (p.cpu) {
      s.turnDeadline = s.clockEnd = null;
      s.timer = { kind: "cpu", at: now + this.cpuGap() };
    } else {
      s.clockEnd = this.clock();
      s.turnDeadline = this.io.isConnected(p.id) ? s.clockEnd : Math.min(s.clockEnd ?? Infinity, now + AWAY_MS);
      s.timer = s.turnDeadline ? { kind: "turn", at: s.turnDeadline } : null;
    }
    this.touch();
  }

  private nextTurn(): void {
    const s = this.s;
    const n = s.order.length;
    for (let i = 1; i <= n; i++) {
      const seat = (s.turn + i) % n;
      if (!s.owner.includes(seat)) continue;
      if (s.turn + i >= n) s.round++;
      return this.beginTurn(seat);
    }
  }

  /** Roll, settle and announce an attack. Checks it's legal; the caller checks it's their turn. */
  private doAttack(p: PlayerState, from: number, to: number): void {
    const s = this.s;
    const problem = attackProblem(s.map!.adj, s.owner, s.dice, p.seat, from, to);
    if (problem) throw new GameError(problem);
    const rng = mulberry32(randomSeed());
    const att = rollDice(rng, s.dice[from]);
    const def = rollDice(rng, s.dice[to]);
    const defender = this.seatPlayer(s.owner[to])!;
    const won = applyAttack(s.owner, s.dice, from, to, att, def);
    s.attackNo++;
    p.attacks++;
    if (won) {
      p.wins++;
      p.captures++;
      s.turnCaptures++;
      p.peak = Math.max(p.peak, territoryCount(s.owner, p.seat));
    }
    this.outbox.push({ t: "attack", attack: { seat: p.seat, from, to, att, def, won }, now: this.io.now() });
    if (won && !s.owner.includes(defender.seat)) {
      defender.outRound = s.round;
      defender.reserve = 0;
      s.knockedOut.push(defender.id);
      this.event(`💀 ${p.name} knocked out ${defender.name}`);
    }
    if (winnerSeat(s.owner) === p.seat) {
      s.winnerId = p.id;
      s.turnDeadline = s.clockEnd = null;
      s.timer = { kind: "finish", at: this.io.now() + FINISH_MS };
      this.event(`🏆 ${p.name} conquers the map!`);
    }
  }

  private cpuStep(p: PlayerState): void {
    const s = this.s;
    const move = cpuAttack(p.cpu!, { adj: s.map!.adj, owner: s.owner, dice: s.dice }, p.seat, mulberry32(randomSeed()));
    if (!move) return this.finishTurn();
    this.doAttack(p, move[0], move[1]);
    if (!s.winnerId) s.timer = { kind: "cpu", at: this.io.now() + this.cpuGap() };
  }

  /** End the current turn: the largest group's worth of dice (plus the reserve) land, then the next turn. */
  private finishTurn(): void {
    const s = this.s;
    const p = this.seatPlayer(s.turn)!;
    const gain = largestGroup(s.map!.adj, s.owner, p.seat);
    const r = reinforce(mulberry32(randomSeed()), s.owner, s.dice, p.seat, gain, p.reserve);
    p.reserve = r.reserve;
    const took = s.turnCaptures ? `took ${s.turnCaptures}, ` : "";
    this.event(`${p.name}: ${took}+${gain} dice${r.reserve ? ` (${r.reserve} saved)` : ""}`);
    this.outbox.push({ t: "drop", drop: { seat: p.seat, gain, placed: r.placed, reserve: r.reserve }, now: this.io.now() });
    s.turnDeadline = s.clockEnd = null;
    s.timer = { kind: "drop", at: this.io.now() + dropMs(r.placed.length, s.settings.fastCpus) };
    this.touch();
  }

  private gameOver(): void {
    const s = this.s;
    s.phase = "gameover";
    s.turn = -1;
    s.timer = null;
    s.turnDeadline = s.clockEnd = null;
    this.touch();
  }
}
