import type { BasePlayer, CpuLevel } from "@warrick/kit/shared/protocol";
import { mulberry32, randomSeed, shuffle } from "@warrick/kit/shared/rng";
import { GameError, Lobby, baseState, type GameIO } from "@warrick/kit/worker/lobby";
import { type ClockRules, startTurnClock, turnHolderBack, turnHolderLeft, turnTimeUp } from "@warrick/kit/worker/turns";
import { cpuMove, type CpuView } from "../shared/ai";
import { AWAY_MS, CPU_THINK_MAX_MS, CPU_THINK_MIN_MS, MAX_DICE, START_DICE, revealMs } from "../shared/constants";
import {
  DEFAULT_SETTINGS,
  SETTING_CHOICES,
  type Bid,
  type GameState,
  type Hands,
  type PlayerState,
  type ServerMsg,
} from "../shared/protocol";
import { bidError, bidText, nextSeat, resolveCall, type RoundRules } from "../shared/rules";
import { rollDice } from "./dice";

export { GameError, type GameIO } from "@warrick/kit/worker/lobby";

const CPU_NAMES = ["Pablo", "Dolores", "Gizmo", "Mabel", "Rex", "Pixel", "Bones", "Lucky", "Moxie", "Snake Eyes"];
/** The turn clock: whoever isn't here on their turn has AWAY_MS before the game moves for them. */
const CLOCK: ClockRules = { awayMs: AWAY_MS };

export function newGameState(code: string, now: number): GameState {
  return {
    ...baseState(code, now, DEFAULT_SETTINGS),
    round: 0,
    order: [],
    turnId: null,
    clockEnd: null,
    turnDeadline: null,
    bids: [],
    reveal: null,
    timer: null,
    winnerId: null,
  };
}

/**
 * Liar's Dice on top of the kit's lobby: rounds, bids, calls, the turn clock and the CPUs.
 *
 * The dice are the hidden information. They live in `live` (the room's in-memory slot, which
 * GameRoom also saves), never in `s`, which goes to every socket. Each player is sent their own
 * cup in a direct message; a call copies the whole round's cups into `s.reveal`.
 */
export class Game extends Lobby<GameState, ServerMsg, Hands> {
  protected readonly choices = SETTING_CHOICES;
  protected readonly cpuNames = CPU_NAMES;
  protected readonly finishedPhase = "gameover";

  constructor(s: GameState, io: GameIO, live: Hands | null = null) {
    super(s, io, live);
    // A game saved before the kit's turn clock kept the clock in `turnDeadline`, and when the
    // turn really ends in its timer.
    if (s.clockEnd === undefined) {
      s.clockEnd = s.turnDeadline;
      if (s.timer?.kind === "turn") s.turnDeadline = s.timer.at;
    }
  }

  protected betweenRounds(): boolean {
    return this.s.phase === "lobby";
  }

  protected createPlayer(base: BasePlayer): PlayerState {
    return {
      ...base,
      // CPUs are always there; a human's flag follows their sockets.
      connected: base.cpu ? true : base.connected,
      dice: 0,
      out: false,
      place: null,
      outRound: null,
      calls: 0,
      callsWon: 0,
      spots: 0,
      spotsWon: 0,
    };
  }

  get rules(): RoundRules {
    return { wild: this.s.settings.wild };
  }

  /** Dice on the table this round. */
  get total(): number {
    return this.s.players.reduce((n, p) => n + p.dice, 0);
  }

  /** Still in the game: not out, and not watching. */
  get alive(): PlayerState[] {
    return this.participants.filter((p) => !p.out);
  }

  /** Can take a turn this round. */
  private canPlay = (id: string): boolean => {
    const p = this.player(id);
    return !!p && !p.spectator && !p.out && p.dice > 0;
  };

  // ---------------------------------------------------------------- players

  setConnected(id: string, connected: boolean): void {
    const p = this.player(id);
    if (!p || p.cpu) return;
    // Every hello lands here: (re)send the player their own cup.
    if (connected) this.sendHand(id);
    // A second tab, or a hello from someone already here, changes nothing else.
    if (p.connected === connected) return;
    p.connected = connected;
    const s = this.s;
    if (s.phase === "playing" && s.turnId === id) {
      // A missing player gets a short grace before the game moves for them; back, they get the clock they had.
      const now = this.io.now();
      this.armTurn(connected ? turnHolderBack(s, CLOCK, now) : turnHolderLeft(s, CLOCK, now));
    }
    this.touch();
  }

  /** Mid-game, leaving counts as going out: your dice stay in this round's count and your turns are skipped. */
  leave(id: string): void {
    const p = this.player(id);
    if (!p) return;
    const s = this.s;
    if (s.phase === "lobby" || p.spectator) {
      this.removePlayer(id);
      this.event(`${p.name} left`);
      return;
    }
    p.connected = false;
    this.event(`${p.name} left the game`);
    if (s.phase === "playing" || s.phase === "reveal") {
      if (!p.out) this.goOut(p);
      if (s.phase === "playing") {
        if (this.alive.length <= 1) this.finish();
        else if (s.turnId === id) this.nextTurn();
      }
    }
    this.touch();
  }

  // ---------------------------------------------------------------- game flow

  start(byId: string): void {
    this.beginStart(byId);
    const s = this.s;
    s.order = shuffle(mulberry32(randomSeed()), this.participants.map((p) => p.id));
    for (const p of s.players) {
      Object.assign(p, { dice: p.spectator ? 0 : START_DICE, out: false, place: null, outRound: null });
      Object.assign(p, { calls: 0, callsWon: 0, spots: 0, spotsWon: 0 });
    }
    s.round = 0;
    s.reveal = null;
    s.winnerId = null;
    const opts = [s.settings.wild ? "ones are wild" : "ones aren't wild", s.settings.spotOn ? "Spot on is allowed" : ""];
    this.event(`Game on! ${s.order.length} players, ${this.total} dice, ${opts.filter(Boolean).join(", ")}.`);
    this.startRound(s.order[0]);
  }

  protected resetForLobby(): void {
    const s = this.s;
    s.round = 0;
    s.order = [];
    s.turnId = null;
    s.clockEnd = s.turnDeadline = null;
    s.bids = [];
    s.reveal = null;
    s.timer = null;
    s.winnerId = null;
    this.live = null;
    for (const p of s.players) Object.assign(p, { dice: 0, out: false, place: null, outRound: null });
  }

  private startRound(starterId: string): void {
    const s = this.s;
    s.round++;
    s.phase = "playing";
    s.bids = [];
    for (const p of s.players) if (p.out || p.spectator) p.dice = 0;
    const dice: Record<string, number[]> = {};
    for (const id of s.order) {
      const p = this.player(id);
      if (p && this.canPlay(id)) dice[id] = rollDice(p.dice);
    }
    this.live = { round: s.round, dice };
    for (const id of Object.keys(dice)) this.sendHand(id);
    this.event(`Round ${s.round}: ${this.total} dice on the table`);
    this.beginTurn(starterId);
  }

  /** The current round's cups. Rolled again if they were lost (a restart between saving the state and the hands). */
  private hands(): Hands {
    const s = this.s;
    if (this.live?.round === s.round) return this.live;
    const dice: Record<string, number[]> = {};
    for (const id of s.order) {
      const p = this.player(id);
      if (p && p.dice > 0) dice[id] = rollDice(p.dice);
    }
    this.live = { round: s.round, dice };
    if (s.phase === "playing") {
      s.bids = [];
      this.event("The server restarted, so everyone rolled again");
      for (const id of Object.keys(dice)) this.sendHand(id);
      this.touch();
    }
    return this.live;
  }

  private sendHand(id: string): void {
    const p = this.player(id);
    if (this.s.phase !== "playing" || !p || p.cpu) return;
    const hands = this.hands();
    const dice = hands.dice[id];
    // hands() may just have rolled again and sent everyone theirs.
    const sent = this.direct.some((d) => d.pid === id && d.msg.t === "hand" && d.msg.round === hands.round);
    if (dice && !sent) this.direct.push({ pid: id, msg: { t: "hand", round: hands.round, dice: [...dice] } });
  }

  private beginTurn(id: string): void {
    const s = this.s;
    const p = this.player(id)!;
    const now = this.io.now();
    s.turnId = id;
    if (p.cpu) {
      s.clockEnd = s.turnDeadline = null;
      s.timer = { kind: "cpu", at: now + CPU_THINK_MIN_MS + Math.random() * (CPU_THINK_MAX_MS - CPU_THINK_MIN_MS) };
    } else {
      this.armTurn(startTurnClock(s, CLOCK, now, s.settings.turnSeconds * 1000, this.io.isConnected(id)));
    }
    this.touch();
  }

  /** The timer for a human's turn: it ends at `at`, or never. */
  private armTurn(at: number | null): void {
    this.s.timer = at === null ? null : { kind: "turn", at };
  }

  private nextTurn(): void {
    const next = nextSeat(this.s.order, this.s.turnId ?? "", this.canPlay);
    if (next) this.beginTurn(next);
    else this.finish();
  }

  private requireTurn(id: string): PlayerState {
    const s = this.s;
    if (s.phase !== "playing") throw new GameError("Wait for the next round");
    if (s.turnId !== id) throw new GameError("It's not your turn");
    return this.player(id)!;
  }

  // ---------------------------------------------------------------- moves

  bid(id: string, qty: unknown, face: unknown): void {
    const p = this.requireTurn(id);
    this.placeBid(p, { qty: Number(qty), face: Number(face) });
  }

  liar(id: string): void {
    this.call(this.requireTurn(id), "liar");
  }

  spot(id: string): void {
    if (!this.s.settings.spotOn) throw new GameError("Spot on is off in this game");
    this.call(this.requireTurn(id), "spot");
  }

  private placeBid(p: PlayerState, bid: Bid): void {
    const s = this.s;
    const err = bidError(s.bids.at(-1) ?? null, bid, this.rules, this.total);
    if (err) throw new GameError(err);
    s.bids.push({ by: p.id, qty: bid.qty, face: bid.face });
    this.nextTurn();
  }

  private call(caller: PlayerState, kind: "liar" | "spot"): void {
    const s = this.s;
    // First the cups: if they were lost, the round is rolled again and its bids are gone with it.
    const hands = this.hands();
    const last = s.bids.at(-1);
    if (!last) throw new GameError("Nothing to call yet: make the first bid");
    const bidder = this.player(last.by)!;
    const cups = s.order.filter((id) => hands.dice[id]?.length).map((id) => ({ id, dice: [...hands.dice[id]] }));
    const result = resolveCall(kind, last, cups.map((c) => c.dice), this.rules);
    const loser = result.loser === "caller" ? caller : result.loser === "bidder" ? bidder : null;
    const gainer = result.callerGains && caller.dice < MAX_DICE ? caller : null;

    if (kind === "liar") {
      caller.calls++;
      if (loser === bidder) caller.callsWon++;
    } else {
      caller.spots++;
      if (result.callerGains) caller.spotsWon++;
    }
    const what = `${bidder.name}'s ${bidText(last)}`;
    const there = `there ${result.count === 1 ? "was" : "were"} ${result.count}`;
    if (kind === "liar") this.event(`${caller.name} called Liar! on ${what}: ${there}. ${loser!.name} loses a die.`);
    else if (result.callerGains) this.event(`${caller.name} called Spot on for ${what}: ${there}! ${gainer ? `${caller.name} gets a die back.` : ""}`.trim());
    else this.event(`${caller.name} called Spot on for ${what}: ${there}. ${caller.name} loses a die.`);

    let outId: string | null = null;
    if (loser) {
      loser.dice--;
      if (loser.dice === 0 && !loser.out) {
        this.goOut(loser);
        outId = loser.id;
      }
    }
    if (gainer) gainer.dice++;

    const now = this.io.now();
    s.reveal = {
      round: s.round,
      kind,
      callerId: caller.id,
      bidderId: bidder.id,
      bid: { qty: last.qty, face: last.face },
      wild: this.rules.wild,
      hands: cups,
      count: result.count,
      loserId: loser?.id ?? null,
      gainerId: gainer?.id ?? null,
      outId,
      at: now,
    };
    s.phase = "reveal";
    s.turnId = null;
    s.clockEnd = s.turnDeadline = null;
    s.timer = { kind: "reveal", at: now + revealMs(result.count) };
    this.touch();
  }

  /** After the reveal: the next round, started by whoever lost (or called Spot on), or the end. */
  private afterReveal(): void {
    const s = this.s;
    const r = s.reveal;
    if (this.alive.length <= 1 || !r) return this.finish();
    const want = r.kind === "liar" ? r.loserId! : r.callerId;
    const starter = this.canPlay(want) ? want : nextSeat(s.order, want, this.canPlay);
    if (!starter) return this.finish();
    this.startRound(starter);
  }

  private goOut(p: PlayerState): void {
    p.place = this.alive.length;
    p.out = true;
    p.outRound = this.s.round;
    this.event(`💀 ${p.name} is out`);
  }

  private finish(): void {
    const s = this.s;
    const winner = this.alive[0] ?? null;
    s.phase = "gameover";
    s.turnId = null;
    s.clockEnd = s.turnDeadline = null;
    s.timer = null;
    s.winnerId = winner?.id ?? null;
    if (winner) {
      winner.place = 1;
      this.event(`🏆 ${winner.name} wins!`);
    }
    this.touch();
  }

  // ---------------------------------------------------------------- CPUs and timers

  /** Everything `id`'s seat may know, for a CPU deciding for it. */
  viewFor(id: string): CpuView {
    const s = this.s;
    const hands = this.hands();
    return {
      me: id,
      hand: hands.dice[id] ?? [],
      seats: s.order.map((pid) => ({ id: pid, dice: this.player(pid)?.dice ?? 0 })).filter((x) => x.dice > 0),
      bids: s.bids,
      rules: this.rules,
      spotOn: s.settings.spotOn,
      maxDice: MAX_DICE,
    };
  }

  private autoMove(p: PlayerState, level: CpuLevel): void {
    const move = cpuMove(this.viewFor(p.id), level, mulberry32(randomSeed()));
    if (move.t === "bid") this.placeBid(p, move);
    else this.call(p, move.t);
  }

  onTimer(): void {
    const s = this.s;
    const t = s.timer;
    if (!t || this.io.now() < t.at - 25) return;
    s.timer = null;
    if (t.kind === "reveal") {
      if (s.phase === "reveal") this.afterReveal();
    } else {
      const p = this.player(s.turnId ?? "");
      if (s.phase === "playing" && p && this.canPlay(p.id)) {
        if (t.kind === "cpu" && p.cpu) this.autoMove(p, p.cpu);
        else if (!turnTimeUp(s, CLOCK, this.io.now())) {
          // Not yet, or noticed long after (the room was empty or restarting): there's time to come back.
          this.armTurn(s.turnDeadline);
        } else {
          this.event(this.io.isConnected(p.id) ? `⏱ ${p.name} ran out of time` : `${p.name} is away, so the game moved for them`);
          this.autoMove(p, "normal");
        }
      }
    }
    this.touch();
  }
}
