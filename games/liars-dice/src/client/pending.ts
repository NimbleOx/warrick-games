/**
 * A move on its way to the server. It's answered (by a state or an error), or after `ms` it's given
 * up on. Each move has its own timeout, so an old move's can't go off while a newer one is waiting.
 */
export class Pending {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private ms: number,
    private onTimeout: () => void,
  ) {}

  /** A move is waiting for its answer. */
  get waiting(): boolean {
    return this.timer !== null;
  }

  /** A move was sent. */
  start(): void {
    this.answered();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onTimeout();
    }, this.ms);
  }

  /** The server answered (or there's no longer anything to wait for). */
  answered(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
