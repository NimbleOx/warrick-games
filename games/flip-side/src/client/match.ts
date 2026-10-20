/**
 * The match on this screen: your own table (stepped here, see `LocalTable`), everyone else's from
 * the room's frames, and the trouble flying between them.
 */

import { LocalTable } from "../shared/local";
import { decodeTable, emptyView, type MatchSnapshot, type TableFrame, type Trouble, type View } from "../shared/protocol";
import type { Play, Rules } from "../shared/sim";
import { TABLE } from "../shared/table";
import { lerpView } from "./render";

/** Rivals' tables are drawn this many ticks behind the clock, between the frames either side. */
export const DELAY = 36;

/** A rival's table from the room's frames. */
export class Ghost {
  private frames: { tick: number; view: View }[] = [];
  private readonly out = emptyView();
  /** The newest frame's table. */
  latest: View | null = null;
  /** The newest frame's tick. */
  tick = -1;

  push(row: TableFrame): void {
    if (row[1] < this.tick) return;
    const view = decodeTable(row);
    this.frames.push({ tick: row[1], view });
    if (this.frames.length > 16) this.frames.shift();
    this.latest = view;
    this.tick = row[1];
  }

  /** The table at match tick `t` (between frames), or null before any frame. */
  at(t: number): View | null {
    const fs = this.frames;
    if (!fs.length) return null;
    if (t >= fs[fs.length - 1].tick) return fs[fs.length - 1].view;
    for (let i = fs.length - 1; i > 0; i--) {
      const a = fs[i - 1];
      const b = fs[i];
      if (t >= a.tick) return lerpView(this.out, a.view, b.view, b.tick > a.tick ? (t - a.tick) / (b.tick - a.tick) : 1);
    }
    return fs[0].view;
  }
}

export class ClientMatch {
  readonly run: number;
  readonly rules: Rules;
  readonly seats: string[];
  /** Your table, if you're playing this match. */
  readonly mine: LocalTable | null;
  readonly ghosts = new Map<string, Ghost>();
  /** Every trouble sent this match. */
  readonly troubles: Trouble[];
  /** The newest frame's match tick. */
  frameTick = 0;

  constructor(snap: MatchSnapshot, me: string, previous: ClientMatch | null) {
    const same = previous?.run === snap.run;
    this.run = snap.run;
    this.rules = snap.rules;
    this.seats = snap.seats;
    this.troubles = same ? previous.troubles : [];
    for (const tr of snap.troubles) if (!this.troubles.some((x) => x.id === tr.id)) this.troubles.push(tr);
    const i = snap.seats.indexOf(me);
    const mineTroubles = snap.troubles.filter((tr) => tr.to === me);
    if (i < 0) this.mine = null;
    else if (same && previous.mine) {
      // The same match going on (after a pause or a reconnect): take the room's game, keep our log.
      this.mine = previous.mine;
      for (const tr of mineTroubles) this.mine.noteTrouble(tr);
      this.mine.adopt(snap.plays[i], snap.inputs[i]);
    } else {
      this.mine = new LocalTable(TABLE, snap.rules, snap.run, { play: snap.plays[i], bits: snap.inputs[i] }, mineTroubles);
    }
    for (const id of snap.seats) {
      if (id === me) continue;
      this.ghosts.set(id, (same && previous.ghosts.get(id)) || new Ghost());
    }
  }

  /** A frame from the room: rivals' tables, and a check on our own (false: it's off). */
  frame(k: number, rows: TableFrame[], me: string): boolean {
    this.frameTick = k;
    let ok = true;
    for (const row of rows) {
      if (row[0] === me) {
        if (this.mine && row[20] >= 0 && !this.mine.check(row[20], row[21])) ok = false;
        continue;
      }
      this.ghosts.get(row[0])?.push(row);
    }
    return ok;
  }

  /** Trouble on its way. False if it's ours and too late to put in: ask the room for our game. */
  trouble(tr: Trouble, me: string): boolean {
    if (!this.troubles.some((x) => x.id === tr.id)) this.troubles.push(tr);
    return tr.to !== me || !this.mine || this.mine.addTrouble(tr);
  }

  /** Steps your table to `target`, reading the controls for each tick. */
  advance(target: number, read: () => number, on: (p: Play) => void): void {
    this.mine?.advance(target, read, on);
  }
}
