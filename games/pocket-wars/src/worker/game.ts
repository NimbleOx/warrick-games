import type { BasePlayer } from "@warrick/kit/shared/protocol";
import { mulberry32, randomSeed, shuffle } from "@warrick/kit/shared/rng";
import { GameError, Lobby, baseState } from "@warrick/kit/worker/lobby";
import { cpuNext } from "../shared/ai";
import {
  ATTACK_MS,
  AWAY_MS,
  BACK_MIN_MS,
  BUILD_MS,
  CAPTURE_MS,
  CPU_FAST_MS,
  CPU_FIRST_MS,
  CPU_GAP_MS,
  FINISH_MS,
  MAX_SEATS,
  MOVE_MS_PER_TILE,
  seatFunds,
} from "../shared/constants";
import { MAPS, mapsFor, type MapDef } from "../shared/maps";
import { DEFAULT_SETTINGS, SETTING_CHOICES, type GameState, type PlayerState, type ServerMsg, type Stats } from "../shared/protocol";
import {
  actProblem,
  applyAct,
  applyBuild,
  buildProblem,
  endTurn,
  knockOut,
  newBoard,
  startTurn,
  winnerSeat,
  type Act,
  type ActEvent,
  type Board,
} from "../shared/rules";
import { UNITS, type UnitType } from "../shared/units";

export { GameError, type GameIO } from "@warrick/kit/worker/lobby";

const CPU_NAMES = ["Sarge", "Major", "Colonel", "Captain", "Marshal", "Corporal", "Brigadier", "Admiral", "Private", "General"];

const freshStats = (): Stats => ({ built: 0, kills: 0, lost: 0, captured: 0 });

export function newGameState(code: string, now: number): GameState {
  return {
    ...baseState(code, now, DEFAULT_SETTINGS),
    mapId: null,
    board: null,
    order: [],
    turn: -1,
    day: 0,
    turnNo: 0,
    actionNo: 0,
    turnDeadline: null,
    clockEnd: null,
    timer: null,
    knockedOut: [],
    winnerId: null,
  };
}

/**
 * Pocket Wars' rules on top of the kit's lobby: turns, unit actions, builds, knockouts and the
 * timers that drive them. The rules themselves are the pure functions in shared/rules.ts; this
 * checks who's asking, runs the CPUs, keeps score and tells everyone what happened. The lobby is
 * only open in the "lobby" phase, and a finished game sits in "gameover" until the host takes
 * everyone back.
 */
export class Game extends Lobby<GameState, ServerMsg> {
  protected readonly choices = SETTING_CHOICES;
  protected readonly cpuNames = CPU_NAMES;
  protected readonly maxPlayers = MAX_SEATS;
  protected readonly finishedPhase = "gameover";

  protected betweenRounds(): boolean {
    return this.s.phase === "lobby";
  }

  protected createPlayer(base: BasePlayer): PlayerState {
    return { ...base, seat: -1, outDay: null, resigned: false, standIn: false, stats: freshStats() };
  }

  private get map(): MapDef {
    return MAPS[this.s.mapId!];
  }

  private get board(): Board {
    return this.s.board!;
  }

  // ---------------------------------------------------------------- players

  /** Leaving mid-game leaves your army behind; the host can hand it to a CPU. */
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
    if (!p || p.cpu || p.seat < 0 || p.outDay !== null) throw new GameError("There's no seat to hand over");
    if (this.io.isConnected(p.id)) throw new GameError(`${p.name} is still here`);
    p.cpu = "normal";
    p.standIn = true;
    this.event(`A CPU takes over for ${p.name}`);
    if (this.isTurnOf(p.id)) {
      s.turnDeadline = s.clockEnd = null;
      s.timer = { kind: "cpu", at: this.io.now() + this.cpuGap(CPU_GAP_MS) };
    }
    this.touch();
  }

  /** Host only, any time: CPUs move without pausing. */
  setFast(byId: string, on: boolean): void {
    this.requireHost(byId);
    this.s.settings.fastCpus = !!on;
    this.touch();
  }

  // ---------------------------------------------------------------- game flow

  start(byId: string): void {
    this.beginStart(byId);
    const s = this.s;
    const n = this.participants.length;
    const rng = mulberry32(randomSeed());
    const m = this.pickMap(n, rng);
    const order = shuffle(rng, this.participants.map((p) => p.id));
    s.mapId = m.id;
    s.board = newBoard(m, seatFunds(m.players));
    s.order = order;
    s.day = 1;
    s.turnNo = 0;
    s.actionNo = 0;
    s.knockedOut = [];
    s.winnerId = null;
    for (const p of s.players) {
      Object.assign(p, { seat: order.indexOf(p.id), outDay: null, resigned: false, stats: freshStats() });
    }
    s.phase = "playing";
    this.event(`Game on! ${m.name}, ${n} armies. Capture an enemy HQ or wipe out an army to knock it out.`);
    this.beginTurn(0);
  }

  private pickMap(n: number, rng: () => number): MapDef {
    const id = this.s.settings.map;
    if (id === "auto") {
      const list = mapsFor(n);
      if (!list.length) throw new GameError(`There's no map for ${n} players`);
      return list[Math.floor(rng() * list.length)];
    }
    const m = MAPS[id];
    if (!m) throw new GameError("Pick a map");
    if (m.players !== n) {
      throw new GameError(`${m.name} is a ${m.players}-player map and there are ${n} players. Pick another map, or Auto.`);
    }
    return m;
  }

  protected resetForLobby(): void {
    const s = this.s;
    Object.assign(s, {
      mapId: null,
      board: null,
      order: [],
      turn: -1,
      day: 0,
      turnNo: 0,
      actionNo: 0,
      turnDeadline: null,
      clockEnd: null,
      timer: null,
      knockedOut: [],
      winnerId: null,
    });
    for (const p of s.players) {
      Object.assign(p, { seat: -1, outDay: null, resigned: false, stats: freshStats() });
      if (p.standIn) {
        p.cpu = null;
        p.standIn = false;
        p.connected = this.io.isConnected(p.id);
      }
    }
  }

  /** A human moves a unit and gives it an action. */
  act(id: string, raw: Partial<Act>): void {
    const p = this.requireTurn(id);
    const act: Act = {
      unit: Number(raw?.unit),
      to: Number(raw?.to),
      action: raw?.action as Act["action"],
      ...(raw?.target === undefined ? {} : { target: Number(raw.target) }),
    };
    const problem = actProblem(this.map, this.board, p.seat, act);
    if (problem) throw new GameError(problem);
    this.doAct(p, act);
    this.afterAction(p);
  }

  /** A human builds a unit at one of their factories. */
  build(id: string, at: number, unit: UnitType): void {
    const p = this.requireTurn(id);
    const problem = buildProblem(this.map, this.board, p.seat, Number(at), unit);
    if (problem) throw new GameError(problem);
    this.doBuild(p, Number(at), unit);
    this.touch();
  }

  endTurn(id: string): void {
    this.requireTurn(id);
    this.finishTurn();
  }

  /** Give up: your army leaves the map and your buildings turn neutral. */
  resign(id: string): void {
    this.requirePhase("playing");
    const s = this.s;
    const p = this.player(id);
    if (!p || p.seat < 0) throw new GameError("You're not in this game");
    if (p.outDay !== null) throw new GameError("You're already out");
    if (s.winnerId) throw new GameError("The game is over");
    knockOut(this.map, this.board, p.seat);
    p.resigned = true;
    this.markOut(p);
    this.event(`🏳 ${p.name} resigns`);
    s.actionNo++;
    if (!this.checkWin() && s.order[s.turn] === p.id) this.nextTurn();
    this.touch();
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

  /** It's this player's turn and the game is on. */
  private isTurnOf(id: string): boolean {
    const s = this.s;
    return s.phase === "playing" && s.order[s.turn] === id && !s.winnerId;
  }

  private requireTurn(id: string): PlayerState {
    const s = this.s;
    const p = this.player(id);
    if (s.phase !== "playing" || !p || p.seat < 0) throw new GameError("You're not in this game");
    if (p.outDay !== null) throw new GameError("You're out of this game");
    if (s.winnerId) throw new GameError("The game is over");
    if (s.order[s.turn] !== id) throw new GameError(`It's ${this.seatPlayer(s.turn)?.name ?? "someone else"}'s turn`);
    if (p.cpu) throw new GameError("A CPU is playing your seat");
    return p;
  }

  /** The turn clock for a human starting to think now. */
  private clock(): number | null {
    const secs = this.s.settings.turnSeconds;
    return secs ? this.io.now() + secs * 1000 : null;
  }

  /** How long a CPU waits before its next step, so everyone can watch the last one. */
  private cpuGap(animMs: number): number {
    return this.s.settings.fastCpus ? CPU_FAST_MS : CPU_GAP_MS + animMs;
  }

  private beginTurn(seat: number): void {
    const s = this.s;
    const p = this.seatPlayer(seat)!;
    const now = this.io.now();
    s.turn = seat;
    s.turnNo++;
    const start = startTurn(this.map, this.board, seat);
    this.outbox.push({ t: "turn", ev: { ...start, day: s.day }, state: s, now });
    if (start.out) {
      this.markOut(p);
      this.event(`💀 ${p.name} has no army and nothing to build, and is out`);
      if (!this.checkWin()) this.nextTurn();
      this.touch();
      return;
    }
    if (p.cpu) {
      s.turnDeadline = s.clockEnd = null;
      s.timer = { kind: "cpu", at: now + this.cpuGap(CPU_FIRST_MS - CPU_GAP_MS) };
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
      if (this.board.out[seat]) continue;
      if (s.turn + i >= n) s.day++;
      return this.beginTurn(seat);
    }
  }

  /** End the current turn: units that didn't act just wait, and the next player goes. */
  private finishTurn(): void {
    const s = this.s;
    endTurn(this.board, s.turn);
    s.turnDeadline = s.clockEnd = null;
    s.timer = null;
    this.nextTurn();
    this.touch();
  }

  private doAct(p: PlayerState, act: Act): ActEvent {
    const s = this.s;
    const ev = applyAct(this.map, this.board, p.seat, act);
    s.actionNo++;
    const victim = ev.targetSeat !== undefined ? this.seatPlayer(ev.targetSeat) : undefined;
    if (ev.killed) {
      p.stats.kills++;
      if (victim) victim.stats.lost++;
      this.event(`💥 ${p.name}'s ${UNITS[ev.type].name} destroyed ${victim?.name ?? "someone"}'s ${UNITS[ev.targetType!].name}`);
    }
    if (ev.lost) {
      p.stats.lost++;
      if (victim) victim.stats.kills++;
      this.event(`💥 ${victim?.name ?? "The defender"}'s ${UNITS[ev.targetType!].name} destroyed ${p.name}'s ${UNITS[ev.type].name}`);
    }
    if (ev.captured) {
      p.stats.captured++;
      const kind = this.map.buildings[ev.building!].kind;
      const home = this.map.hq.indexOf(ev.building!);
      if (kind === "hq" && home >= 0 && ev.out?.includes(home)) this.event(`🚩 ${p.name} captured ${this.seatPlayer(home)?.name}'s HQ!`);
      else this.event(`🚩 ${p.name} captured ${kind === "hq" ? "an HQ" : `a ${kind}`}`);
    }
    this.outbox.push({ t: "act", ev, state: s, now: this.io.now() });
    for (const seat of ev.out ?? []) {
      const out = this.seatPlayer(seat);
      if (!out) continue;
      this.markOut(out);
      this.event(`💀 ${out.name} is out`);
    }
    this.checkWin();
    return ev;
  }

  private doBuild(p: PlayerState, at: number, unit: UnitType): void {
    const ev = applyBuild(this.map, this.board, p.seat, at, unit);
    p.stats.built++;
    this.s.actionNo++;
    this.outbox.push({ t: "build", ev, state: this.s, now: this.io.now() });
  }

  /** After a human's action: their turn goes on, unless it knocked them out. */
  private afterAction(p: PlayerState): void {
    if (!this.s.winnerId && this.board.out[p.seat]) this.nextTurn();
    this.touch();
  }

  private cpuStep(p: PlayerState): void {
    const s = this.s;
    const m = this.map;
    const b = this.board;
    const mv = cpuNext(p.cpu!, m, b, p.seat, mulberry32(randomSeed()), s.day);
    if (mv.kind === "end") return this.finishTurn();
    let anim = BUILD_MS;
    if (mv.kind === "act") {
      const problem = actProblem(m, b, p.seat, mv.act);
      if (problem) {
        console.error("CPU tried an illegal move", problem, mv.act);
        return this.finishTurn();
      }
      const ev = this.doAct(p, mv.act);
      anim = (ev.path.length - 1) * MOVE_MS_PER_TILE + (ev.action === "attack" ? ATTACK_MS : ev.action === "capture" ? CAPTURE_MS : 0);
    } else {
      const problem = buildProblem(m, b, p.seat, mv.at, mv.unit);
      if (problem) {
        console.error("CPU tried an illegal build", problem, mv);
        return this.finishTurn();
      }
      this.doBuild(p, mv.at, mv.unit);
    }
    if (s.winnerId) return;
    if (b.out[p.seat]) return this.nextTurn();
    s.timer = { kind: "cpu", at: this.io.now() + this.cpuGap(anim) };
  }

  private markOut(p: PlayerState): void {
    if (p.outDay !== null) return;
    p.outDay = this.s.day;
    this.s.knockedOut.push(p.id);
  }

  /** If one army is left, it wins: show the banner, then the standings. */
  private checkWin(): boolean {
    const s = this.s;
    if (s.winnerId) return true;
    const seat = winnerSeat(this.board);
    if (seat === null) return false;
    const w = this.seatPlayer(seat)!;
    s.winnerId = w.id;
    s.turnDeadline = s.clockEnd = null;
    s.timer = { kind: "finish", at: this.io.now() + FINISH_MS };
    this.event(`🏆 ${w.name} wins on day ${s.day}!`);
    return true;
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
