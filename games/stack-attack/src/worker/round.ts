import { choose, cpuPace, type CpuLevel } from "../shared/ai";
import { COLS, LOCK_DELAY_MS, MAX_LOCK_RESETS, MAX_PLAYERS, SPAWN_X, SPAWN_Y } from "../shared/constants";
import { Lane, reachable, type LockResult, type Placement } from "../shared/engine";
import { isPiece } from "../shared/pieces";
import { attackScale, gravityMs, levelAt, type Aim, type Op, type RoundSnap, type SeatSnap, type Speed } from "../shared/protocol";
import { shuffle, type Rng } from "../shared/rng";

/** A disconnected player gets this long to come back before the autopilot takes their board. */
const AWAY_GRACE_MS = 2500;
const AUTOPILOT_MS = 1100;

interface Seat {
  slot: number;
  lane: Lane;
  /** Epoch: bumped whenever the server overrules the browser. Locks from an older epoch are ignored. */
  e: number;
  /** The newest garbage id sent to this board. */
  g: number;
  kos: number;
  /** Garbage sent, after the multiplier. */
  atk: number;
  place: number;
  outAt: number;
  cpu: CpuLevel | null;
  lastLockAt: number;
  /** When a CPU or the autopilot next moves. */
  nextMoveAt: number;
  awaySince: number;
}

export interface RoundOptions {
  seed: number;
  goAt: number;
  speed: Speed;
  aim: Aim;
  /** The players' slots, and their CPU level if they're a CPU. */
  slots: { slot: number; cpu: CpuLevel | null }[];
  rng: Rng;
}

export interface LockMsg {
  e: number;
  k: number;
  pl: Placement;
  g: number;
  ck: number;
}

/**
 * One round on the server. Each player's browser plays its own board and reports every
 * piece it locks; the round checks the piece really could have gone there, replays it into
 * its copy of the board, and routes the garbage. CPUs, players who've dropped and pieces
 * left hanging are moved here.
 */
export class Round {
  readonly seed: number;
  readonly goAt: number;
  readonly speed: Speed;
  readonly aim: Aim;
  seats: (Seat | null)[] = Array(MAX_PLAYERS).fill(null);
  over = false;
  /** Ops since the last frame went out. */
  ops: Op[] = [];
  /** Slots whose browser needs to be told what its board really looks like. */
  fixes = new Set<number>();
  private rng: Rng;
  private garbageId = 0;

  constructor(o: RoundOptions) {
    this.seed = o.seed;
    this.goAt = o.goAt;
    this.speed = o.speed;
    this.aim = o.aim;
    this.rng = o.rng;
    for (const { slot, cpu } of o.slots) {
      this.seats[slot] = {
        slot,
        lane: new Lane(o.seed),
        e: 0,
        g: 0,
        kos: 0,
        atk: 0,
        place: 0,
        outAt: 0,
        cpu,
        lastLockAt: o.goAt,
        nextMoveAt: o.goAt + (cpu ? cpuPace(cpu, o.rng) : 0),
        awaySince: 0,
      };
    }
  }

  get alive(): number {
    return this.seats.filter((s) => s && !s.lane.out).length;
  }

  level(now: number): number {
    return levelAt(this.speed, now - this.goAt);
  }

  seat(slot: number): Seat | null {
    return this.seats[slot] ?? null;
  }

  /** A piece a player's browser locked. */
  lock(slot: number, m: LockMsg, now: number): void {
    const seat = this.seats[slot];
    if (!seat || seat.lane.out || this.over || now < this.goAt - 1000) return;
    // From before the server last overruled this browser, or a repeat: drop it.
    if (m.e !== seat.e || m.k !== seat.lane.pc) return;
    const lane = seat.lane;
    const pl = cleanPlacement(m.pl);
    const g = Number(m.g);
    const piece = pl && (pl.hold ? lane.swapped : lane.current);
    const ok =
      pl &&
      Number.isInteger(g) &&
      g >= lane.ack &&
      g <= seat.g &&
      pl.piece === piece &&
      reachable(lane.board, pl.piece, pl);
    const res = ok ? lane.lock(pl, g) : null;
    if (!res) {
      this.overrule(seat, now);
      return;
    }
    this.landed(seat, res, now);
    if (lane.checksum() !== m.ck) this.overrule(seat, now);
  }

  /** Server-side moves: CPUs, the autopilot for players who've dropped, and pieces left hanging. */
  tick(now: number, away: (slot: number) => boolean): void {
    if (this.over || now < this.goAt) return;
    for (const seat of this.seats) {
      if (!seat || seat.lane.out || this.over) continue;
      if (seat.cpu) {
        if (now < seat.nextMoveAt) continue;
        this.autoMove(seat, seat.cpu, now);
        seat.nextMoveAt = now + cpuPace(seat.cpu, this.rng);
      } else if (away(seat.slot)) {
        if (!seat.awaySince) {
          seat.awaySince = now;
          seat.nextMoveAt = now + AWAY_GRACE_MS;
        }
        if (now < seat.nextMoveAt) continue;
        this.autoMove(seat, "easy", now);
        this.overrule(seat, now);
        seat.nextMoveAt = now + AUTOPILOT_MS;
      } else {
        seat.awaySince = 0;
        if (now - seat.lastLockAt > this.deadline(now)) {
          // The browser stopped (a background tab, say). Drop the piece where it spawns.
          const p = seat.lane.current;
          const pl = { piece: p, r: 0, x: SPAWN_X, y: seat.lane.board.drop(p, 0, SPAWN_X, SPAWN_Y), hold: false, spin: 0 };
          const res = seat.lane.lock(pl, seat.g);
          if (res) this.landed(seat, res, now);
          this.overrule(seat, now);
        }
      }
    }
  }

  /** A player left mid-round: they're out, with nobody credited. */
  leave(slot: number, now: number): void {
    const seat = this.seats[slot];
    if (!seat || seat.lane.out) return;
    seat.lane.out = true;
    this.knockOut(seat, now, false);
  }

  snapshot(round: number, who: (string | null)[]): RoundSnap {
    return {
      round,
      seed: this.seed,
      goAt: this.goAt,
      speed: this.speed,
      who,
      seats: this.seats.map((s) => (s ? this.seatSnap(s) : null)),
      over: this.over,
    };
  }

  seatSnap(s: Seat): SeatSnap {
    return { ...s.lane.snap(), e: s.e, g: s.g, kos: s.kos, atk: s.atk, place: s.place };
  }

  /** Seconds each slot lasted. */
  survived(slot: number, now: number): number {
    const s = this.seats[slot];
    if (!s) return 0;
    return Math.max(0, ((s.outAt || now) - this.goAt) / 1000);
  }

  // ---------------------------------------------------------------- internals

  /** How long a piece can hang before the server drops it: a fall from the top plus every lock reset, and then some. */
  private deadline(now: number): number {
    return 22 * gravityMs(this.level(now)) + MAX_LOCK_RESETS * LOCK_DELAY_MS + 5000;
  }

  private autoMove(seat: Seat, level: CpuLevel, now: number): void {
    const lane = seat.lane;
    const pl = choose(lane, level, this.rng, seat.g);
    const res = pl && lane.lock(pl, seat.g);
    if (res) {
      this.landed(seat, res, now);
    } else {
      // Nowhere to go at all.
      lane.out = true;
      this.knockOut(seat, now, true);
    }
  }

  private landed(seat: Seat, res: LockResult, now: number): void {
    const lane = seat.lane;
    seat.lastLockAt = now;
    const out = res.sent && Math.round(res.sent * attackScale(this.speed, now - this.goAt));
    const target = out ? this.target(seat.slot) : null;
    if (target) seat.atk += out;
    this.ops.push({
      k: "l",
      s: seat.slot,
      b: lane.board.encode(),
      n: lane.n,
      hold: lane.hold,
      pc: lane.pc,
      combo: lane.combo,
      b2b: lane.b2b,
      q: lane.pending(),
      lines: lane.lines,
      atk: seat.atk,
      c: res.cleared.length,
      sp: res.spin,
      a: res.attack,
      pcl: res.pc,
      ins: res.inserted,
    });
    if (target) this.attack(seat.slot, target, out);
    if (res.out) this.knockOut(seat, now, true);
  }

  private attack(from: number, target: Seat, lines: number): void {
    const id = ++this.garbageId;
    const hole = Math.floor(this.rng() * COLS);
    target.lane.queue.push({ id, lines, hole, from });
    target.g = id;
    this.ops.push({ k: "g", id, from, to: target.slot, lines, hole });
  }

  private target(from: number): Seat | null {
    const opps = shuffle(
      this.rng,
      this.seats.filter((s): s is Seat => !!s && s.slot !== from && !s.lane.out),
    );
    if (!opps.length || this.aim === "random") return opps[0] ?? null;
    // How close each board is to the top, counting garbage already on its way.
    const risk = (s: Seat) => s.lane.board.height() + s.lane.pending();
    opps.sort((a, b) => (this.aim === "strongest" ? risk(a) - risk(b) : risk(b) - risk(a)));
    return opps[0];
  }

  private knockOut(seat: Seat, now: number, credit: boolean): void {
    seat.place = this.alive + 1;
    seat.outAt = now;
    const by = credit ? seat.lane.lastHitBy : -1;
    const killer = by >= 0 && by !== seat.slot ? this.seats[by] : null;
    if (killer) killer.kos++;
    this.ops.push({ k: "ko", s: seat.slot, by: killer ? by : -1, place: seat.place });
    if (this.alive <= 1) {
      this.over = true;
      for (const s of this.seats) {
        if (s && !s.lane.out) {
          s.place = 1;
          s.outAt = now;
        }
      }
    }
  }

  private overrule(seat: Seat, now: number): void {
    seat.e++;
    seat.lastLockAt = now;
    this.fixes.add(seat.slot);
  }
}

function cleanPlacement(raw: unknown): Placement | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const ints = [p.r, p.x, p.y, p.spin].every((v) => Number.isInteger(v));
  if (!ints || !isPiece(p.piece) || typeof p.hold !== "boolean") return null;
  const spin = p.spin as number;
  if (spin < 0 || spin > 5) return null;
  return { piece: p.piece, r: p.r as number, x: p.x as number, y: p.y as number, hold: p.hold, spin };
}
