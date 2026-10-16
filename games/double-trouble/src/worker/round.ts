import { MAX_PLAYERS } from "@warrick/kit/shared/constants";
import { shuffle, type Rng } from "@warrick/kit/shared/rng";
import { choose, cpuPace, type CpuLevel } from "../shared/ai";
import { IDLE_DROP_MS } from "../shared/constants";
import { Lane, isDir, type Dir, type MoveResult } from "../shared/engine";
import { attackScale, type Aim, type Goal, type Op, type RoundSnap, type SeatSnap, type Size } from "../shared/protocol";

/**
 * Rocks sent to a board this long before one of its moves arrives count as seen, whatever the
 * move says. A browser that never reports rocks can't keep them from landing; an honest one
 * reports them a round trip after they're sent.
 */
const SEEN_AFTER_MS = 1500;
/** Moves a browser can make: bursts of up to this many, refilling at MOVE_RATE a second. Beyond any human. */
const MOVE_BURST = 20;
const MOVE_RATE = 15;

interface Seat {
  slot: number;
  lane: Lane;
  /** Epoch: bumped whenever the server overrules the browser. Moves from an older epoch are ignored. */
  e: number;
  /** The newest garbage id sent to this board. */
  g: number;
  /** When each garbage id this board hasn't yet reported was sent. */
  inbound: { id: number; at: number }[];
  /** Moves the browser can make right now, and when that was worked out. */
  moves: number;
  movesAt: number;
  kos: number;
  /** Rocks sent, after the multiplier. */
  atk: number;
  place: number;
  outAt: number;
  cpu: CpuLevel | null;
  /** When a CPU next moves. */
  nextMoveAt: number;
  lastMoveAt: number;
  /** When rocks started waiting for this board (0: none waiting). */
  waitingSince: number;
}

export interface RoundOptions {
  seed: number;
  goAt: number;
  size: Size;
  goal: Goal;
  aim: Aim;
  /** The players' slots, and their CPU level if they're a CPU. */
  slots: { slot: number; cpu: CpuLevel | null }[];
  rng: Rng;
}

export interface MoveMsg {
  e: number;
  k: number;
  d: Dir;
  g: number;
  ck: number;
}

/**
 * One round on the server. Each player's browser plays its own board and reports every move;
 * the round replays it into its copy of the board and routes the rocks. CPUs move here, and so
 * do the rocks that drop on a player who's stopped moving.
 */
export class Round {
  readonly seed: number;
  readonly goAt: number;
  readonly size: Size;
  readonly goal: Goal;
  readonly aim: Aim;
  seats: (Seat | null)[] = Array(MAX_PLAYERS).fill(null);
  over = false;
  /** How the round was won, once it's over. */
  how: "goal" | "last" | null = null;
  /** Ops since the last frame went out. */
  ops: Op[] = [];
  /** Slots whose browser needs to be told what its board really looks like. */
  fixes = new Set<number>();
  private rng: Rng;
  private garbageId = 0;
  private goalExp: number;

  constructor(o: RoundOptions) {
    this.seed = o.seed;
    this.goAt = o.goAt;
    this.size = o.size;
    this.goal = o.goal;
    this.goalExp = o.goal ? Math.log2(o.goal) : 0;
    this.aim = o.aim;
    this.rng = o.rng;
    for (const { slot, cpu } of o.slots) {
      this.seats[slot] = {
        slot,
        lane: new Lane(o.seed, o.size),
        e: 0,
        g: 0,
        inbound: [],
        moves: MOVE_BURST,
        movesAt: o.goAt,
        kos: 0,
        atk: 0,
        place: 0,
        outAt: 0,
        cpu,
        nextMoveAt: o.goAt + (cpu ? cpuPace(cpu, o.rng) : 0),
        lastMoveAt: o.goAt,
        waitingSince: 0,
      };
    }
  }

  get alive(): number {
    return this.seats.filter((s) => s && !s.lane.out).length;
  }

  seat(slot: number): Seat | null {
    return this.seats[slot] ?? null;
  }

  /** A move a player's browser made. */
  move(slot: number, m: MoveMsg, now: number): void {
    const seat = this.seats[slot];
    if (!seat || seat.lane.out || this.over) return;
    // From before the server last overruled this browser: the fix on its way puts it right.
    if (m.e !== seat.e) return;
    const lane = seat.lane;
    const g = Number(m.g);
    // Rocks the browser has had plenty of time to hear about count as seen even if it says
    // otherwise; the move is then overruled, so the browser takes the server's board.
    const seen = Math.max(g, this.due(seat, now));
    const ok =
      now >= this.goAt - 500 &&
      this.spend(seat, now) &&
      m.k === lane.n &&
      isDir(m.d) &&
      Number.isInteger(g) &&
      g >= lane.ack &&
      g <= seat.g;
    const res = ok ? lane.move(m.d, seen) : null;
    if (!res) {
      this.overrule(seat);
      return;
    }
    this.moved(seat, res, now);
    if (seen !== g || lane.checksum() !== m.ck) this.overrule(seat);
  }

  /** Server-side moves: CPUs, and rocks dropping on players who've stopped moving. */
  tick(now: number): void {
    if (this.over || now < this.goAt) return;
    for (const seat of this.seats) {
      if (!seat || seat.lane.out || this.over) continue;
      const lane = seat.lane;
      if (seat.cpu) {
        if (now < seat.nextMoveAt) continue;
        seat.nextMoveAt = now + cpuPace(seat.cpu, this.rng);
        const d = choose(lane, seat.cpu, this.rng);
        const res = d === null ? null : lane.move(d, seat.g);
        if (res) {
          this.moved(seat, res, now);
        } else {
          lane.out = true;
          this.knockOut(seat, now, true);
        }
      } else if (lane.queue.length && now - Math.max(seat.lastMoveAt, seat.waitingSince) >= IDLE_DROP_MS) {
        // Sitting still doesn't keep the rocks away.
        const landed = lane.drop();
        seat.lastMoveAt = now;
        if (!lane.queue.length) seat.waitingSince = 0;
        this.ops.push(this.boardOp(seat, -1, { combo: 0, attack: 0, landed: landed.length, smashed: 0 }));
        this.overrule(seat);
        if (lane.out) this.knockOut(seat, now, true);
      }
    }
  }

  /** A player left mid-round: they're out, with nobody credited. */
  leave(slot: number, now: number): void {
    const seat = this.seats[slot];
    if (!seat || seat.lane.out || this.over) return;
    seat.lane.out = true;
    this.knockOut(seat, now, false);
  }

  snapshot(round: number, who: (string | null)[]): RoundSnap {
    return {
      round,
      seed: this.seed,
      goAt: this.goAt,
      size: this.size,
      goal: this.goal,
      who,
      seats: this.seats.map((s) => (s ? this.seatSnap(s) : null)),
      over: this.over,
    };
  }

  seatSnap(s: Seat): SeatSnap {
    return { ...s.lane.snap(), e: s.e, g: s.g, kos: s.kos, atk: s.atk, place: s.place };
  }

  /** Seconds a slot lasted. */
  survived(slot: number, now: number): number {
    const s = this.seats[slot];
    if (!s) return 0;
    return Math.max(0, ((s.outAt || now) - this.goAt) / 1000);
  }

  // ---------------------------------------------------------------- internals

  /** The newest garbage id sent to this board at least SEEN_AFTER_MS ago, or 0. */
  private due(seat: Seat, now: number): number {
    this.prune(seat);
    let id = 0;
    for (const x of seat.inbound) {
      if (now - x.at < SEEN_AFTER_MS) break;
      id = x.id;
    }
    return id;
  }

  /** Forget send times for garbage the board has already reported. */
  private prune(seat: Seat): void {
    const sent = seat.inbound;
    while (sent.length && sent[0].id <= seat.lane.ack) sent.shift();
  }

  /** Take one move from the browser's allowance. False if it's moving faster than anyone can. */
  private spend(seat: Seat, now: number): boolean {
    if (now > seat.movesAt) {
      seat.moves = Math.min(MOVE_BURST, seat.moves + ((now - seat.movesAt) * MOVE_RATE) / 1000);
      seat.movesAt = now;
    }
    if (seat.moves < 1) return false;
    seat.moves--;
    return true;
  }

  private moved(seat: Seat, res: MoveResult, now: number): void {
    const lane = seat.lane;
    seat.lastMoveAt = now;
    if (!lane.queue.length) seat.waitingSince = 0;
    const out = res.sent && Math.round(res.sent * attackScale(now - this.goAt));
    const target = out ? this.target(seat.slot) : null;
    if (target) seat.atk += out;
    const smashed = res.hits.filter((h) => h.hp === 0).length;
    this.ops.push(this.boardOp(seat, res.dir, { combo: res.combo, attack: res.attack, landed: res.landed.length, smashed }));
    if (target) this.attack(seat.slot, target, out, now);
    if (this.goalExp && lane.best >= this.goalExp) this.win(seat, now);
    else if (res.out) this.knockOut(seat, now, true);
  }

  private boardOp(seat: Seat, d: Dir | -1, x: { combo: number; attack: number; landed: number; smashed: number }): Op {
    const lane = seat.lane;
    return {
      k: "m",
      s: seat.slot,
      d,
      b: lane.board.encode(),
      n: lane.n,
      score: lane.score,
      charge: lane.charge,
      q: lane.pending(),
      atk: seat.atk,
      smashed: lane.smashed,
      c: x.combo,
      a: x.attack,
      ins: x.landed,
      sm: x.smashed,
    };
  }

  private attack(from: number, target: Seat, rocks: number, now: number): void {
    const id = ++this.garbageId;
    if (!target.lane.queue.length) target.waitingSince = now;
    target.lane.queue.push({ id, rocks, from, at: -1 });
    target.g = id;
    this.prune(target);
    target.inbound.push({ id, at: now });
    this.ops.push({ k: "g", id, from, to: target.slot, rocks });
  }

  private target(from: number): Seat | null {
    const opps = shuffle(
      this.rng,
      this.seats.filter((s): s is Seat => !!s && s.slot !== from && !s.lane.out),
    );
    if (!opps.length || this.aim === "random") return opps[0] ?? null;
    if (this.aim === "leader") {
      opps.sort((a, b) => b.lane.best - a.lane.best || b.lane.score - a.lane.score);
    } else {
      // Closest to filling up, counting rocks already on their way.
      const risk = (s: Seat) => s.lane.board.filled() + s.lane.pending();
      opps.sort((a, b) => risk(b) - risk(a));
    }
    return opps[0];
  }

  private win(seat: Seat, now: number): void {
    this.over = true;
    this.how = "goal";
    seat.place = 1;
    seat.outAt = now;
    this.ops.push({ k: "goal", s: seat.slot });
    // Everyone else still in is placed by their biggest tile, then their score.
    const rest = this.seats
      .filter((s): s is Seat => !!s && s !== seat && !s.lane.out)
      .sort((a, b) => b.lane.best - a.lane.best || b.lane.score - a.lane.score);
    rest.forEach((s, i) => {
      s.place = i + 2;
      s.outAt = now;
    });
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
      this.how = "last";
      for (const s of this.seats) {
        if (s && !s.lane.out) {
          s.place = 1;
          s.outAt = now;
        }
      }
    }
  }

  private overrule(seat: Seat): void {
    seat.e++;
    this.fixes.add(seat.slot);
  }
}
