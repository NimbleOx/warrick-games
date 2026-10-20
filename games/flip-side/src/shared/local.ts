/**
 * Your own table, on your own screen: it's stepped here first, so the flippers answer at once,
 * and the room steps the same game from the inputs this sends (see `PlayMsg`). Both get the same
 * game bit for bit; the room's hashes in its frames check that, and if they ever differ this
 * takes the room's game and plays on from there with its own inputs (`adopt`).
 *
 * Trouble from rivals lands at a tick the room picks, a second after it's sent, so it's nearly
 * always here before its tick. If it's late (a slow connection), this goes back to a snapshot
 * from before that tick and plays forwards again with the trouble in, as the room does.
 *
 * No DOM here, so the tests can play it against the real room.
 */

import { HASH_EVERY } from "./constants";
import type { InputEvent, PlayMsg, Trouble } from "./protocol";
import { Play, applyTrouble, playFromNumbers, playHash32, playNumbers, startPlay, stepPlay, type Rules } from "./sim";
import type { Table } from "./table";

/** How long hashes are kept for checking, in ticks. */
const KEEP_HASHES = 20 * HASH_EVERY;
/** A snapshot every this many ticks, kept for this many, to go back to when trouble is late. */
const SNAP_EVERY = 30;
const KEEP_SNAPS = 16;

export class LocalTable {
  readonly play: Play;
  /** The game a tick ago, for drawing between ticks. */
  readonly prev = new Play();
  /** Every input change this run, by tick, from the start (or from where a snapshot took over). */
  log: InputEvent[] = [];
  /** Trouble for this table, by tick; what's landed stays, for going back. */
  troubles: Trouble[] = [];
  /** The first tick the next message covers. */
  private sendFrom: number;
  private readonly hashes = new Map<number, number>();
  private snaps: number[][] = [];

  constructor(
    readonly table: Table,
    readonly rules: Rules,
    readonly run: number,
    snapshot?: { play: readonly number[]; bits: number },
    troubles: readonly Trouble[] = [],
  ) {
    this.play = snapshot ? playFromNumbers(snapshot.play) : startPlay(rules);
    this.log.push([this.play.tick, snapshot?.bits ?? 0]);
    this.prev.copyFrom(this.play);
    this.sendFrom = this.play.tick;
    for (const tr of troubles) if (tr.at >= this.play.tick) this.troubles.push(tr);
    this.troubles.sort((a, b) => a.at - b.at || a.id - b.id);
  }

  /** Steps the game up to `target`. `read` gives the input bits for each tick (logged when they change). */
  advance(target: number, read: () => number, onStep?: (p: Play) => void): void {
    while (this.play.tick < target) {
      const bits = read();
      const last = this.log[this.log.length - 1];
      if (last[1] !== bits) {
        if (last[0] === this.play.tick) this.log[this.log.length - 1] = [this.play.tick, bits];
        else this.log.push([this.play.tick, bits]);
      }
      this.step(bits);
      onStep?.(this.play);
    }
  }

  private step(bits: number): void {
    const p = this.play;
    this.prev.copyFrom(p);
    for (const tr of this.troubles) if (tr.at === p.tick) applyTrouble(p, tr.kind, tr.param, this.table);
    stepPlay(p, bits, this.table, this.rules);
    const t = p.tick;
    if (t % HASH_EVERY === 0) {
      this.hashes.set(t, playHash32(p));
      this.hashes.delete(t - KEEP_HASHES);
    }
    if (t % SNAP_EVERY === 0) {
      this.snaps.push(playNumbers(p));
      if (this.snaps.length > KEEP_SNAPS) this.snaps.shift();
    }
  }

  /** The input bits in effect at a tick. */
  inputAt(tick: number): number {
    let bits = this.log[0][1];
    for (const e of this.log) {
      if (e[0] > tick) break;
      bits = e[1];
    }
    return bits;
  }

  /** Trouble for this table, noted without going back for it (an `adopt` is about to). */
  noteTrouble(tr: Trouble): boolean {
    if (this.troubles.some((x) => x.id === tr.id)) return false;
    this.troubles.push(tr);
    this.troubles.sort((a, b) => a.at - b.at || a.id - b.id);
    return true;
  }

  /**
   * Trouble for this table. If its tick has passed here, the game goes back to before it and
   * plays forwards again. False if it's too late even for that: ask the room for its game.
   */
  addTrouble(tr: Trouble): boolean {
    if (!this.noteTrouble(tr)) return true;
    const p = this.play;
    if (tr.at >= p.tick) return true;
    let snap: number[] | null = null;
    for (const s of this.snaps) if (s[0] <= tr.at) snap = s;
    if (!snap) return false;
    const was = p.tick;
    const from = snap[0];
    this.snaps = this.snaps.filter((s) => s[0] <= from);
    playFromNumbers(snap, p);
    this.replayTo(was);
    return true;
  }

  /**
   * The message to send now: the input in effect where the last one sent left off, every change
   * since, and how far we are. Call `sent` once it's gone (a message that couldn't go is covered
   * by the next one).
   */
  message(): PlayMsg {
    const from = this.sendFrom;
    const ev: InputEvent[] = [[from, this.inputAt(from)], ...this.log.filter((e) => e[0] > from)];
    return { t: "play", run: this.run, ev, upTo: this.play.tick };
  }

  sent(msg: PlayMsg): void {
    this.sendFrom = Math.max(this.sendFrom, msg.upTo);
  }

  /** Whether the room's hash of our game at `tick` matches ours (true if we can't tell). */
  check(tick: number, hash: number): boolean {
    const ours = this.hashes.get(tick);
    return ours === undefined || ours === hash;
  }

  /**
   * Take the room's game (from a sync or a snapshot) and play it on to where we were, with our
   * own inputs from its tick: what the room will do with the inputs we've sent. The next message
   * restates everything from its tick, in case some of ours never arrived.
   */
  adopt(nums: readonly number[], bits: number): void {
    const was = this.play.tick;
    playFromNumbers(nums, this.play);
    const t = this.play.tick;
    // Ours from its tick on stay after the room's: the room will apply them too.
    this.log = [...this.log.filter((e) => e[0] < t), [t, bits], ...this.log.filter((e) => e[0] >= t)];
    // Hashes and snapshots from before are of the game we just dropped.
    this.hashes.clear();
    this.snaps = [];
    if (t % HASH_EVERY === 0) this.hashes.set(t, playHash32(this.play));
    this.sendFrom = t;
    this.replayTo(was);
  }

  /** Steps on to `tick` with the logged inputs, as the room will with the inputs it has. */
  private replayTo(tick: number): void {
    const p = this.play;
    let next = this.log.findIndex((e) => e[0] > p.tick);
    if (next < 0) next = this.log.length;
    let bits = this.inputAt(p.tick);
    while (p.tick < tick) {
      while (next < this.log.length && this.log[next][0] <= p.tick) bits = this.log[next++][1];
      this.step(bits);
    }
    this.prev.copyFrom(p);
  }
}
