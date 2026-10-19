// The lines the board hasn't drawn yet, in the order they were played. Each one plays in turn, and
// a long run plays faster, so chains don't drag. Timers move it on, not animation frames, which
// stop in background tabs and hidden panes. When it falls behind (a long backlog, or a timer that
// came late because the page is throttled) it draws everything waiting at once.

/** The pause after a line, by how many are still waiting behind it. */
export function lineGap(left: number): number {
  return left > 8 ? 45 : left > 3 ? 80 : 140;
}

/** With more lines than this waiting, they're drawn at once instead of played. */
export const SNAP_BACKLOG = 24;
/** A timer this late (ms) means the page is being throttled: draw the rest at once. */
export const LATE_MS = 1000;

/** What the queue needs from the game screen. */
export interface LineHooks {
  /** Draw these lines, in order. `quiet` when they were hurried to catch up: no sounds. */
  show(edges: number[], quiet: boolean): void;
  /** The last line waiting has been drawn. */
  done(quiet: boolean): void;
}

export class LineQueue {
  private lines: number[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** When the next line may play: the pause after the last one. */
  private due = 0;

  constructor(
    private readonly hooks: LineHooks,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Lines waiting to be drawn. */
  get length(): number {
    return this.lines.length;
  }

  get busy(): boolean {
    return this.lines.length > 0;
  }

  /** New lines from a state, in order. */
  push(edges: readonly number[]): void {
    if (!edges.length) return;
    this.lines.push(...edges);
    if (this.lines.length > SNAP_BACKLOG) this.flush();
    else this.schedule();
  }

  /** Draw everything waiting, at once and quietly. */
  flush(): void {
    this.stop();
    if (!this.lines.length) return;
    const all = this.lines;
    this.lines = [];
    this.hooks.show(all, true);
    this.hooks.done(true);
  }

  /** Forget what's waiting without drawing it: the board is about to snap to a state. */
  clear(): void {
    this.stop();
    this.lines = [];
  }

  private stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.timer !== undefined || !this.lines.length) return;
    const at = Math.max(this.now(), this.due);
    this.timer = setTimeout(() => this.tick(at), at - this.now());
  }

  private tick(at: number): void {
    this.timer = undefined;
    const now = this.now();
    if (now - at > LATE_MS) return this.flush();
    const e = this.lines.shift()!;
    this.due = now + lineGap(this.lines.length);
    this.hooks.show([e], false);
    if (this.lines.length) this.schedule();
    else this.hooks.done(false);
  }
}
