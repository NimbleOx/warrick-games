import type { BasePlayer } from "@warrick/kit/shared/protocol";
import { mulberry32, randomSeed, type Rng } from "@warrick/kit/shared/rng";
import { GameError, Lobby, baseState, cleanName, type GameIO } from "@warrick/kit/worker/lobby";
import {
  AHEAD_SLACK,
  COUNTDOWN_MS,
  HASH_EVERY,
  LEAN_MAX,
  MAX_BEHIND,
  PLAYER_COLORS,
  RESULTS_MS,
  TICK_HZ,
} from "../shared/constants";
import { generateCourse, progressOf } from "../shared/course";
import {
  DEFAULT_SETTINGS,
  F_AWAY,
  F_CRASHED,
  F_FINISHED,
  F_HELD,
  SETTING_CHOICES,
  courseSpec,
  encodeRider,
  formatTicks,
  ordinal,
  pointsFor,
  rankPlayers,
  type CourseResult,
  type GameState,
  type PlayerState,
  type RideMsg,
  type ServerMsg,
} from "../shared/protocol";
import { decodeInput, encodeInput, rideHash32, rideNumbers, stepRide, type InputEvent } from "../shared/ride";
import { Race, type RaceRider } from "./race";

export { GameError, type GameIO } from "@warrick/kit/worker/lobby";

const CPU_NAMES = ["Rusty", "Knobby", "Clutch", "Revvy", "Mudflap", "Scoot", "Sprocket", "Hops", "Gravel", "Wheelie"];
/** The most input changes one ride message may carry. */
const MAX_EVENTS = 240;
/** A rider is sent their bike at most this often, in ms. */
const SYNC_MS = 500;

export function newGameState(code: string, now: number): GameState {
  return {
    ...baseState(code, now, DEFAULT_SETTINGS),
    course: 0,
    seed: 0,
    run: 0,
    startAt: null,
    riders: [],
    finishes: {},
    endTick: null,
    results: null,
    solo: false,
    phaseDeadline: null,
    timer: null,
  };
}

/**
 * Dust Up's rules on top of the kit's lobby: a series of courses, the countdown, riding, the
 * results and points. The room's tick steps every bike (humans from their inputs, CPUs from their
 * pilots) and sends a frame. The lobby is only open in the "lobby" phase, and a finished series
 * sits in "gameover" until the host takes everyone back.
 */
export class Game extends Lobby<GameState, ServerMsg, Race> {
  protected readonly choices = SETTING_CHOICES;
  protected readonly colors = PLAYER_COLORS;
  protected readonly cpuNames = CPU_NAMES;
  protected readonly finishedPhase = "gameover";

  constructor(
    s: GameState,
    io: GameIO,
    race: Race | null = null,
    private rng: Rng = mulberry32(randomSeed()),
  ) {
    super(s, io, race);
  }

  /** The course being ridden: the kit's `live`, in memory only. See `recover()`. */
  get race(): Race | null {
    return this.live;
  }

  set race(race: Race | null) {
    this.live = race;
  }

  protected betweenRounds(): boolean {
    return this.s.phase === "lobby";
  }

  protected createPlayer(base: BasePlayer): PlayerState {
    return { ...base, points: 0, wins: 0 };
  }

  /** Someone arriving mid-series gets a seat, and rides from the next course. */
  protected joinMidGame(): boolean {
    return true;
  }

  // ---------------------------------------------------------------- players

  /** Someone who leaves their name blank is "Rider 3", not "Player 3". */
  addHuman(rawName: string): PlayerState {
    return super.addHuman(cleanName(rawName, `Rider ${this.s.nextPlayerNum}`));
  }

  leave(id: string): void {
    const p = this.player(id);
    if (!p) return;
    // Leaving mid-course takes the bike off the course too.
    this.race?.remove(id);
    this.s.riders = this.s.riders.filter((r) => r !== id);
    delete this.s.finishes[id];
    super.leave(id);
  }

  // ---------------------------------------------------------------- riding

  /** A rider's inputs (see `RideMsg`). */
  ride(id: string, msg: RideMsg): void {
    const s = this.s;
    const r = this.race?.rider(id);
    if (!r || r.pilot || msg.run !== s.run || (s.phase !== "countdown" && s.phase !== "riding")) return;
    const ev = cleanEvents(msg.ev);
    if (ev === null) return;
    if (ev.length) {
      // The message restates the input from its first tick: it replaces what was queued from there.
      const from = ev[0][0];
      r.pending = r.pending.filter((e) => e[0] < from);
      r.pending.push(...ev);
    }
    if (Number.isInteger(msg.upTo) && msg.upTo > r.upTo) r.upTo = msg.upTo;
    // Back from a stall: the room rode on without them, so send them where their bike is now.
    if (r.away) this.sync(r);
  }

  /** A rider's bike didn't match the room's: send them the room's. */
  resync(id: string, run: number): void {
    const r = this.race?.rider(id);
    if (!r || r.pilot || run !== this.s.run) return;
    this.sync(r, true);
  }

  private sync(r: RaceRider, now = false): void {
    const t = this.io.now();
    if (!now && t - r.syncedAt < SYNC_MS) return;
    r.syncedAt = t;
    this.direct.push({
      pid: r.id,
      msg: { t: "sync", run: this.s.run, ride: rideNumbers(r.ride), input: [encodeInput(r.input), r.input.lean] },
    });
  }

  /** One step of the course, every FRAME_MS while it's being ridden: every bike up to the clock. */
  tick(): void {
    const s = this.s;
    const race = this.race;
    if (s.phase !== "riding" || !race || s.startAt === null) return;
    const clock = Math.floor(((this.io.now() - s.startAt) * TICK_HZ) / 1000);
    race.clock = clock;
    const end = s.endTick ?? race.course.capTicks;
    for (const r of race.riders) {
      let target = r.pilot ? clock : Math.min(r.upTo, clock + AHEAD_SLACK);
      const away = !r.pilot && target < clock - MAX_BEHIND;
      if (away) {
        // They've gone, or their page stalled: ride on without them, with nothing pressed.
        target = clock - MAX_BEHIND;
        r.pending = r.pending.filter((e) => e[0] >= target);
        r.input.throttle = r.input.brake = r.input.respawn = r.input.lean = 0;
      }
      r.away = away;
      const before = r.ride.tick;
      this.step(r, Math.min(target, end));
      if (away && r.ride.tick > before && this.io.isConnected(r.id)) this.sync(r);
    }
    this.outbox.push({
      t: "frame",
      run: race.run,
      k: clock,
      r: race.riders.map((r) => {
        const b = r.ride.bike;
        const flags =
          (b.crashed ? F_CRASHED : 0) |
          (r.ride.finishTick >= 0 ? F_FINISHED : 0) |
          (r.input.respawn ? F_HELD : 0) |
          (r.away ? F_AWAY : 0);
        return encodeRider(r.id, r.ride, flags, r.cpAt, r.hashTick, r.hash);
      }),
    });

    // Everyone's home, or the course is over and every bike has been stepped to its end.
    const done = race.riders.every((r) => r.ride.finishTick >= 0);
    if (done || clock >= end + MAX_BEHIND) this.finishCourse();
  }

  /** Steps a bike up to `target`, noting checkpoints, the finish and its hashes. */
  private step(r: RaceRider, target: number): void {
    const race = this.race!;
    const course = race.course;
    const ride = r.ride;
    while (ride.tick < target) {
      if (r.pilot) r.pilot.decide(ride, course, r.input);
      else {
        while (r.pending.length && r.pending[0][0] <= ride.tick) {
          const [, bits, lean] = r.pending.shift()!;
          decodeInput(bits, lean, r.input);
        }
      }
      const cp = ride.checkpoint;
      const finished = ride.finishTick >= 0;
      stepRide(ride, r.input, course);
      if (ride.checkpoint !== cp) r.cpAt = ride.tick;
      if (!finished && ride.finishTick >= 0) this.finished(r);
      if (!r.pilot && ride.tick % HASH_EVERY === 0) {
        r.hashTick = ride.tick;
        r.hash = rideHash32(ride);
      }
    }
  }

  private finished(r: RaceRider): void {
    const s = this.s;
    const ticks = r.ride.finishTick;
    s.finishes[r.id] = ticks;
    const first = Object.keys(s.finishes).length === 1;
    if (first) {
      const cap = this.race!.course.capTicks;
      s.endTick = Math.min(cap, ticks + s.settings.window * TICK_HZ);
    }
    const p = this.player(r.id);
    const place = Object.values(s.finishes).filter((t) => t < ticks).length + 1;
    const alone = this.race!.riders.length === 1;
    if (p) this.event(`🏁 ${p.name} finished${alone ? "" : ` ${ordinal(place)}`} in ${formatTicks(ticks)}`);
    this.touch();
  }

  // ---------------------------------------------------------------- the series

  start(byId: string): void {
    // Drops players who closed their tab in the lobby, and seats watchers in any free seats.
    this.beginStart(byId, 1, "riders");
    for (const p of this.s.players) p.points = p.wins = 0;
    this.s.course = 0;
    this.s.seed = Math.floor(this.rng() * 4294967296) >>> 0;
    const n = this.s.settings.courses;
    this.event(`Engines on! ${n} course${n > 1 ? "s" : ""}, ${this.s.settings.length} and ${this.s.settings.difficulty}.`);
    this.startCourse(false);
  }

  /** Solo, after a course: ride the same course again. */
  again(byId: string): void {
    const s = this.s;
    this.requireHost(byId);
    if (s.phase !== "results" || !s.solo) throw new GameError("Not right now");
    this.event(`Course ${s.course} again`);
    this.startCourse(true);
  }

  /** Solo, after a course: go on to the next one (or the final results). */
  next(byId: string): void {
    const s = this.s;
    this.requireHost(byId);
    if (s.phase !== "results" || !s.solo) throw new GameError("Not right now");
    this.afterResults();
  }

  protected resetForLobby(): void {
    const s = this.s;
    s.course = 0;
    s.startAt = null;
    s.riders = [];
    s.finishes = {};
    s.endTick = null;
    s.results = null;
    s.solo = false;
    s.phaseDeadline = null;
    s.timer = null;
    this.race = null;
  }

  /**
   * Called when riders come back to a course that stopped stepping. A course paused with nobody
   * connected goes on after a countdown, with every bike where it was. The race only lives in
   * memory, so if the room restarted, the course starts again from the gate.
   */
  recover(): void {
    const s = this.s;
    if (s.phase !== "countdown" && s.phase !== "riding") return;
    if (!this.race) {
      this.event(`Course ${s.course} was interrupted — starting it again`);
      this.startCourse(true);
    } else if (s.phase === "riding" || (s.phaseDeadline ?? 0) < this.io.now()) {
      this.event(`Going on with course ${s.course}`);
      this.countdown(this.race.clock);
    }
  }

  private startCourse(again: boolean): void {
    const s = this.s;
    if (!again) s.course++;
    s.run++;
    s.results = null;
    s.finishes = {};
    s.solo = false;
    // Riders who have gone away sit this one out, unless nobody's left.
    let riders = this.participants.filter((p) => p.cpu || this.io.isConnected(p.id));
    if (!riders.length) riders = this.participants;
    s.riders = riders.map((p) => p.id);
    const course = generateCourse(courseSpec(s));
    this.race = new Race(course, s.run, riders);
    s.endTick = course.capTicks;
    if (!again) this.event(`Course ${s.course} of ${s.settings.courses}`);
    this.countdown(0);
  }

  /** The gate drops (or the paused course goes on) in COUNTDOWN_MS, at course tick `from`. */
  private countdown(from: number): void {
    const s = this.s;
    const now = this.io.now();
    s.phase = "countdown";
    s.phaseDeadline = now + COUNTDOWN_MS;
    s.startAt = s.phaseDeadline - (from * 1000) / TICK_HZ;
    s.timer = { kind: "countdown", at: s.phaseDeadline };
    this.outbox.push({ t: "race", race: this.race!.snapshot() });
    this.touch();
  }

  private finishCourse(): void {
    const s = this.s;
    const race = this.race!;
    const results = rankRiders(race);
    for (const res of results) {
      const p = this.player(res.id);
      if (!p) continue;
      p.points += res.points;
      if (res.place === 1 && res.ticks !== null) p.wins++;
    }
    s.results = results;
    s.phase = "results";
    s.solo = s.riders.length === 1 && this.participants.length === 1;
    const winner = results[0]?.ticks !== null ? this.player(results[0]?.id ?? "") : undefined;
    if (s.solo) {
      const r = results[0];
      this.event(r?.ticks != null ? `Course ${s.course}: ${formatTicks(r.ticks)}` : `Course ${s.course}: didn't finish`);
    } else if (winner) this.event(`🏆 ${winner.name} wins course ${s.course}`);
    else this.event(`Course ${s.course}: nobody finished`);
    // On your own, you go on when you like (or ride it again); otherwise after a pause.
    s.phaseDeadline = s.solo ? null : this.io.now() + RESULTS_MS;
    s.timer = s.solo ? null : { kind: "results", at: s.phaseDeadline! };
    this.touch();
  }

  private afterResults(): void {
    const s = this.s;
    if (s.course >= s.settings.courses) {
      s.phase = "gameover";
      s.phaseDeadline = null;
      s.timer = null;
      this.race = null;
      const best = [...this.participants].sort(rankPlayers)[0];
      if (best && !s.solo) this.event(`🎉 ${best.name} wins the series!`);
      this.touch();
      return;
    }
    this.startCourse(false);
  }

  // ---------------------------------------------------------------- timers

  onTimer(): void {
    // The race was lost (the room restarted, or slept through the countdown): start it again.
    if (!this.race) this.recover();
    const s = this.s;
    const t = s.timer;
    if (!t || this.io.now() < t.at - 25) return;
    s.timer = null;
    switch (t.kind) {
      case "countdown":
        if (s.phase === "countdown") {
          s.phase = "riding";
          s.phaseDeadline = null;
        }
        break;
      case "results":
        if (s.phase === "results") this.afterResults();
        break;
    }
    this.touch();
  }
}

/** The riders in order: finishers by time (a tie shares a place), then the rest by how far they got. */
export function rankRiders(race: Race): CourseResult[] {
  const course = race.course;
  const rows = race.riders.map((r) => {
    const ticks = r.ride.finishTick >= 0 ? r.ride.finishTick : null;
    const progress = ticks !== null ? 1 : Math.min(0.999, progressOf(course, r.ride.bike.x));
    return { id: r.id, ticks, progress };
  });
  rows.sort((a, b) =>
    a.ticks !== null && b.ticks !== null
      ? a.ticks - b.ticks
      : a.ticks !== null
        ? -1
        : b.ticks !== null
          ? 1
          : b.progress - a.progress,
  );
  const results: CourseResult[] = [];
  rows.forEach((row, i) => {
    const prev = results[i - 1];
    const tie = prev && prev.ticks === row.ticks && (row.ticks !== null || prev.progress === row.progress);
    const place = tie ? prev.place : i + 1;
    results.push({ ...row, place, points: row.ticks !== null ? pointsFor(place) : 0 });
  });
  return results;
}

/** A ride message's inputs, checked: whole ticks in order, known bits, lean in range. Null if they're no good. */
function cleanEvents(raw: unknown): InputEvent[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_EVENTS) return null;
  const out: InputEvent[] = [];
  let last = -1;
  for (const e of raw) {
    if (!Array.isArray(e) || e.length !== 3) return null;
    const [tick, bits, lean] = e as unknown[];
    if (!Number.isInteger(tick) || !Number.isInteger(bits) || !Number.isInteger(lean)) return null;
    const t = tick as number;
    if (t < 0 || t < last || (bits as number) < 0 || (bits as number) > 7) return null;
    out.push([t, bits as number, Math.max(-LEAN_MAX, Math.min(LEAN_MAX, lean as number))]);
    last = t;
  }
  return out;
}
