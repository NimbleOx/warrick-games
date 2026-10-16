import { MAX_QUEUED_TURNS, opposite, type Dir } from "../shared/arena";

/** How many ticks later than expected a sent turn can show up before it counts as turned down. */
const GRACE_TICKS = 10;

interface Sent {
  dir: Dir;
  /** The last tick it can show up on. */
  by: number;
}

/**
 * The turns you've sent that the screen hasn't shown yet. A turn takes a round trip and the
 * playback buffer to come back in a frame, so your head shows the next one straight away.
 * It keeps the server's rules for queueing turns (`Arena.queueTurn`), applied to your heading
 * on screen plus the turns still on their way. It's only a cue: the frames still steer.
 */
export class TurnCue {
  private sent: Sent[] = [];

  /** The turn your head should show, if any. */
  get next(): Dir | null {
    return this.sent[0]?.dir ?? null;
  }

  /**
   * You've just sent a turn while heading `dir` on screen, with frame `tick` the newest received.
   * Returns false for a turn the server will ignore: straight ahead, a U-turn, or too many queued.
   */
  send(turn: Dir, dir: Dir, tick: number): boolean {
    const last = this.sent.at(-1)?.dir ?? dir;
    if (turn === last || turn === opposite(last) || this.sent.length >= MAX_QUEUED_TURNS) return false;
    this.sent.push({ dir: turn, by: tick + this.sent.length + 1 + GRACE_TICKS });
    return true;
  }

  /** Frame `tick` has been shown, and it took your heading from `before` to `after`. */
  shown(before: Dir, after: Dir, tick: number): void {
    if (after !== before) {
      // The server only turns you when you ask, in the order you asked. A turn we weren't
      // expecting means we've lost track, so start over.
      const k = this.sent.findIndex((t) => t.dir === after);
      this.sent.splice(0, k < 0 ? this.sent.length : k + 1);
    }
    // Long overdue: the server turned it down, so the ones after it won't line up either.
    if (this.sent.length && tick > this.sent[0].by) this.sent = [];
  }

  clear(): void {
    this.sent = [];
  }
}
