import type { BasePlayer } from "@warrick/kit/shared/protocol";
import { mulberry32, randInt, randomSeed, type Rng } from "@warrick/kit/shared/rng";
import { Lobby, baseState, cleanName, type GameIO } from "@warrick/kit/worker/lobby";
import { Pilot } from "../shared/ai";
import { AHEAD_SLACK, COUNTDOWN_MS, HASH_EVERY, MAX_BEHIND, PLAYER_COLORS, TICK_HZ, TROUBLE_LEAD } from "../shared/constants";
import {
  DEFAULT_SETTINGS,
  F_AWAY,
  SETTING_CHOICES,
  encodeTable,
  formatScore,
  rulesFor,
  type GameState,
  type InputEvent,
  type PlayMsg,
  type PlayerState,
  type ResultRow,
  type ServerMsg,
  type Trouble,
} from "../shared/protocol";
import { EV_SEND, TROUBLES, applyTrouble, playHash32, playNumbers, stepPlay } from "../shared/sim";
import { TABLE } from "../shared/table";
import { Match, type Seat } from "./match";

export { GameError, type GameIO } from "@warrick/kit/worker/lobby";

const CPU_NAMES = ["Tilt", "Bumper", "Flipper", "Plunger", "Jackpot", "Gutter", "Spinner", "Kicker", "Rollover", "Saucer"];
/** The most input changes one play message may carry. */
const MAX_EVENTS = 300;
/** A player is sent their game at most this often, in ms. */
const SYNC_MS = 500;

export function newGameState(code: string, now: number): GameState {
  return {
    ...baseState(code, now, DEFAULT_SETTINGS),
    run: 0,
    match: 0,
    startAt: null,
    seats: [],
    results: null,
    phaseDeadline: null,
    timer: null,
  };
}

/**
 * Flip Side's rules on top of the kit's lobby: a match, its countdown, every table played at
 * once, the trouble sent between them, and the results. The room's tick steps every table
 * (humans from their inputs, CPUs from their pilots) and sends a frame. Between matches (the
 * lobby, and the results) the lobby's rules apply: the host can start another straight away.
 */
export class Game extends Lobby<GameState, ServerMsg, Match> {
  protected readonly choices = SETTING_CHOICES;
  protected readonly colors = PLAYER_COLORS;
  protected readonly cpuNames = CPU_NAMES;
  protected readonly finishedPhase = "results";

  constructor(
    s: GameState,
    io: GameIO,
    match: Match | null = null,
    private rng: Rng = mulberry32(randomSeed()),
  ) {
    super(s, io, match);
  }

  /** The match being played: the kit's `live`, in memory only. See `recover()`. */
  get match(): Match | null {
    return this.live;
  }

  set match(match: Match | null) {
    this.live = match;
  }

  protected betweenRounds(): boolean {
    return this.s.phase === "lobby" || this.s.phase === "results";
  }

  protected createPlayer(base: BasePlayer): PlayerState {
    return { ...base, wins: 0 };
  }

  /** Someone arriving mid-match gets a seat, and plays from the next match. */
  protected joinMidGame(): boolean {
    return true;
  }

  // ---------------------------------------------------------------- players

  addHuman(rawName: string): PlayerState {
    return super.addHuman(cleanName(rawName, `Player ${this.s.nextPlayerNum}`));
  }

  leave(id: string): void {
    if (!this.player(id)) return;
    // Leaving mid-match takes the table out of it too.
    this.match?.remove(id);
    this.s.seats = this.s.seats.filter((x) => x !== id);
    super.leave(id);
    if (this.isPlaying() && !this.s.seats.length) {
      this.event("Nobody's left playing");
      this.s.phase = "lobby";
      this.resetForLobby();
      this.touch();
    }
  }

  private isPlaying(): boolean {
    return this.s.phase === "countdown" || this.s.phase === "playing";
  }

  // ---------------------------------------------------------------- playing

  /** A player's inputs (see `PlayMsg`). */
  play(id: string, msg: PlayMsg): void {
    const seat = this.match?.seat(id);
    if (!seat || seat.pilot || msg.run !== this.s.run || !this.isPlaying()) return;
    const ev = cleanEvents(msg.ev);
    if (ev === null) return;
    if (ev.length) {
      // The message restates the input from its first tick: it replaces what was queued from there.
      const from = ev[0][0];
      seat.pending = seat.pending.filter((e) => e[0] < from);
      seat.pending.push(...ev);
    }
    if (Number.isInteger(msg.upTo) && msg.upTo > seat.upTo) seat.upTo = msg.upTo;
    // Back from a stall: the room played on for them, so send them where their table is now.
    if (seat.away) this.sync(seat);
  }

  /** A player's game didn't match the room's: send them the room's. */
  resync(id: string, run: number): void {
    const seat = this.match?.seat(id);
    if (!seat || seat.pilot || run !== this.s.run) return;
    this.sync(seat, true);
  }

  private sync(seat: Seat, now = false): void {
    const t = this.io.now();
    if (!now && t - seat.syncedAt < SYNC_MS) return;
    seat.syncedAt = t;
    this.direct.push({ pid: seat.id, msg: { t: "sync", run: this.s.run, play: playNumbers(seat.play), bits: seat.bits } });
  }

  /** One step of the match, every FRAME_MS while it's played: every table up to the clock. */
  tick(): void {
    const s = this.s;
    const match = this.match;
    if (s.phase !== "playing" || !match || s.startAt === null) return;
    const clock = Math.floor(((this.io.now() - s.startAt) * TICK_HZ) / 1000);
    match.clock = clock;
    const end = match.rules.endTick;
    for (const seat of match.seats) {
      let target = seat.pilot ? clock : Math.min(seat.upTo, clock + AHEAD_SLACK);
      const away = !seat.pilot && target < clock - MAX_BEHIND;
      if (away) {
        // They've gone, or their page stalled: the autopilot plays on for them.
        target = clock - MAX_BEHIND;
        seat.pending = seat.pending.filter((e) => e[0] >= target);
        seat.autopilot ??= new Pilot("normal", randomSeed());
      } else seat.autopilot = null;
      seat.away = away;
      const before = seat.play.tick;
      this.step(seat, Math.min(target, end));
      if (away && seat.play.tick > before && this.io.isConnected(seat.id)) this.sync(seat);
    }
    this.outbox.push({
      t: "frame",
      run: match.run,
      k: clock,
      r: match.seats.map((seat) => encodeTable(seat.id, seat.play, seat.away ? F_AWAY : 0, seat.hashTick, seat.hash)),
    });
    // Every table is over, or the match is, and every table has been stepped to its end.
    if (match.seats.every((seat) => seat.play.over) || clock >= end + MAX_BEHIND) this.finishMatch();
  }

  /** Steps a table up to `target`, landing trouble on it and routing what it sends. */
  private step(seat: Seat, target: number): void {
    const match = this.match!;
    const p = seat.play;
    while (p.tick < target && !p.over) {
      const pilot = seat.pilot ?? seat.autopilot;
      if (pilot) seat.bits = pilot.decide(p, TABLE, match.rules);
      else {
        while (seat.pending.length && seat.pending[0][0] <= p.tick) seat.bits = seat.pending.shift()![1];
      }
      while (seat.troubles.length && seat.troubles[0].at <= p.tick) {
        const tr = seat.troubles.shift()!;
        if (tr.at === p.tick) applyTrouble(p, tr.kind, tr.param, TABLE);
      }
      stepPlay(p, seat.bits, TABLE, match.rules);
      for (const e of p.events) if (e.k === EV_SEND) this.send(seat);
      if (!seat.pilot && p.tick % HASH_EVERY === 0) {
        seat.hashTick = p.tick;
        seat.hash = playHash32(p);
      }
    }
    // A finished table still counts the clock, so its frames keep up.
    if (p.over && p.tick < target) p.tick = target;
  }

  /** A table's power is full: trouble goes to a rival, landing a second from now. */
  private send(from: Seat): void {
    const match = this.match!;
    const aim = this.s.settings.trouble;
    const rivals = match.seats.filter((x) => x !== from && !x.play.over);
    if (aim === "off" || !rivals.length) return;
    let to = rivals[Math.floor(this.rng() * rivals.length)];
    if (aim === "leader") to = rivals.reduce((a, b) => (b.play.score > a.play.score ? b : a));
    const tr: Trouble = {
      id: match.troubles.length + 1,
      from: from.id,
      to: to.id,
      kind: TROUBLES[Math.floor(this.rng() * TROUBLES.length)],
      at: Math.max(match.clock, to.play.tick) + TROUBLE_LEAD,
      param: randInt(this.rng, 0, TABLE.brickSpots.length - 1),
    };
    match.troubles.push(tr);
    to.troubles.push(tr);
    to.troubles.sort((a, b) => a.at - b.at || a.id - b.id);
    this.outbox.push({ t: "trouble", run: match.run, tr });
  }

  // ---------------------------------------------------------------- the match

  start(byId: string): void {
    // Drops players who closed their tab in the lobby, and seats watchers in any free seats.
    this.beginStart(byId, 1, "players");
    this.s.match++;
    this.startMatch(false);
  }

  protected resetForLobby(): void {
    const s = this.s;
    s.startAt = null;
    s.seats = [];
    s.results = null;
    s.phaseDeadline = null;
    s.timer = null;
    this.match = null;
  }

  /**
   * Called when players come back to a match that stopped stepping. A match paused with nobody
   * connected goes on after a countdown, with every table where it was. The match only lives in
   * memory, so if the room restarted, it starts again.
   */
  recover(): void {
    const s = this.s;
    if (!this.isPlaying()) return;
    if (!this.match) {
      this.event("The match was interrupted — starting it again");
      this.startMatch(true);
    } else if (s.phase === "playing" || (s.phaseDeadline ?? 0) < this.io.now()) {
      this.event("Going on with the match");
      this.countdown(this.match.clock);
    }
  }

  private startMatch(again: boolean): void {
    const s = this.s;
    s.run++;
    s.results = null;
    // Players who have gone away sit this one out, unless nobody's left.
    let players = this.participants.filter((p) => p.cpu || this.io.isConnected(p.id));
    if (!players.length) players = this.participants;
    s.seats = players.map((p) => p.id);
    const rules = rulesFor(s.settings, Math.floor(this.rng() * 4294967296) >>> 0);
    this.match = new Match(rules, s.run, players);
    if (!again) {
      const { mode, minutes, balls } = s.settings;
      this.event(
        mode === "timed" ? `Match ${s.match}: ${minutes} minutes, top score wins` : `Match ${s.match}: ${balls} balls each`,
      );
    }
    this.countdown(0);
  }

  /** The balls go in (or the paused match goes on) in COUNTDOWN_MS, at match tick `from`. */
  private countdown(from: number): void {
    const s = this.s;
    const now = this.io.now();
    s.phase = "countdown";
    s.phaseDeadline = now + COUNTDOWN_MS;
    s.startAt = s.phaseDeadline - (from * 1000) / TICK_HZ;
    s.timer = { kind: "countdown", at: s.phaseDeadline };
    this.outbox.push({ t: "match", match: this.match!.snapshot() });
    this.touch();
  }

  private finishMatch(): void {
    const s = this.s;
    const match = this.match!;
    const rows = rankSeats(match);
    const solo = match.seats.length === 1 && this.participants.length === 1;
    const top = rows[0];
    if (!solo) {
      for (const row of rows) {
        const p = this.player(row.id);
        if (p && row.place === 1 && row.score > 0) p.wins++;
      }
    }
    s.results = { rows, mode: match.rules.mode, solo };
    s.phase = "results";
    s.phaseDeadline = null;
    s.timer = null;
    const winner = this.player(top?.id ?? "");
    if (solo) this.event(`Match ${s.match}: ${formatScore(top?.score ?? 0)}`);
    else if (winner && top.score > 0) {
      const tied = rows.filter((r) => r.place === 1).length > 1;
      this.event(tied ? `🏆 A tie at ${formatScore(top.score)}!` : `🏆 ${winner.name} wins with ${formatScore(top.score)}`);
    }
    this.touch();
  }

  // ---------------------------------------------------------------- timers

  onTimer(): void {
    // The match was lost (the room restarted, or slept through the countdown): start it again.
    if (!this.match) this.recover();
    const s = this.s;
    const t = s.timer;
    if (!t || this.io.now() < t.at - 25) return;
    s.timer = null;
    if (t.kind === "countdown" && s.phase === "countdown") {
      s.phase = "playing";
      s.phaseDeadline = null;
    }
    this.touch();
  }
}

/** The tables in order of score; equal scores share a place. */
export function rankSeats(match: Match): ResultRow[] {
  const rows = match.seats
    .map((seat) => ({
      id: seat.id,
      score: seat.play.score,
      place: 0,
      sent: seat.play.sent,
      jackpots: seat.play.jackpots,
      drains: seat.play.drains,
    }))
    .sort((a, b) => b.score - a.score);
  rows.forEach((row, i) => {
    row.place = i > 0 && rows[i - 1].score === row.score ? rows[i - 1].place : i + 1;
  });
  return rows;
}

/** A play message's inputs, checked: whole ticks in order, known bits. Null if they're no good. */
function cleanEvents(raw: unknown): InputEvent[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_EVENTS) return null;
  const out: InputEvent[] = [];
  let last = -1;
  for (const e of raw) {
    if (!Array.isArray(e) || e.length !== 2) return null;
    const [tick, bits] = e as unknown[];
    if (!Number.isInteger(tick) || !Number.isInteger(bits)) return null;
    const t = tick as number;
    const b = bits as number;
    if (t < 0 || t < last || b < 0 || b > 15) return null;
    out.push([t, b]);
    last = t;
  }
  return out;
}
