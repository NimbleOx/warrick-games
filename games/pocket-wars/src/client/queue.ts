// The queue of server events on the game screen. Each event plays in turn (the unit slides along
// its path, then its action) and then the state that came with it is applied. Timers move it on,
// not animation frames, which stop in background tabs. It keeps up with the server: a Fast CPU's
// step plays within the gap before the next one, and when events still pile up it applies them at
// once. Your own turn never waits behind an animation, since your clock is already running.
import { ATTACK_MS, BUILD_MS, CPU_FAST_MS, MOVE_MS_PER_TILE } from "../shared/constants";
import type { GameState, TurnEvent } from "../shared/protocol";
import type { ActEvent, BuildEvent } from "../shared/rules";

/** Server events wait here while an earlier one plays; plain states queue behind them. */
export type Item =
  | { kind: "act"; ev: ActEvent; state: GameState }
  | { kind: "build"; ev: BuildEvent; state: GameState }
  | { kind: "turn"; ev: TurnEvent; state: GameState }
  | { kind: "state"; state: GameState };

/** An event that plays on the map. */
export type Played = Extract<Item, { kind: "act" | "build" }>;

export interface Anim {
  item: Played;
  start: number;
  /** Time spent sliding along the path, then the action, in ms. */
  moveMs: number;
  actionMs: number;
  fired: boolean;
}

/** With this many events waiting behind it, an event is applied at once instead of played. */
export const SNAP_BACKLOG = 3;

/** How long an event plays at full speed. Your own units don't slide: you moved them. */
export function playMs(item: Played, own: boolean): { moveMs: number; actionMs: number } {
  if (item.kind === "build") return { moveMs: 0, actionMs: BUILD_MS };
  const ev = item.ev;
  return {
    moveMs: own ? 0 : (ev.path.length - 1) * MOVE_MS_PER_TILE,
    actionMs: ev.action === "attack" ? ATTACK_MS : ev.action === "capture" ? 700 : 120,
  };
}

/** A CPU's step with Fast CPUs on: the server sends the next one CPU_FAST_MS later. */
export function fastCpuStep(item: Played): boolean {
  const s = item.state;
  return s.settings.fastCpus && !!s.players.find((p) => p.id === s.order[item.ev.seat])?.cpu;
}

/** What the queue needs from the game screen. */
export interface QueueHooks {
  /** The seat this client plays, or -1. */
  seat(): number;
  /** Whether events can play: not with no board on screen, or in a hidden tab. Otherwise they're just applied. */
  canPlay(): boolean;
  /** Show a state: one that came with an event, or a plain one. */
  apply(state: GameState): void;
  /** A turn started. Its state is already applied. */
  turn(ev: TurnEvent, state: GameState): void;
  /** An event started playing. */
  started(a: Anim): void;
  /** An event's action lands: its effects and sounds. `quiet` when it was hurried to catch up: effects only. */
  fire(a: Anim, quiet: boolean): void;
}

export class EventQueue {
  items: Item[] = [];
  /** The event playing now. */
  anim: Anim | null = null;

  constructor(private readonly hooks: QueueHooks) {}

  get busy(): boolean {
    return !!this.anim || this.items.length > 0;
  }

  /** Events waiting behind the one playing (plain states don't count). */
  backlog(): number {
    return this.items.filter((i) => i.kind !== "state").length;
  }

  /** Too far behind to play what's waiting: too many events, or your own turn behind them. */
  behind(): boolean {
    const seat = this.hooks.seat();
    return this.backlog() >= SNAP_BACKLOG || (seat >= 0 && this.items.some((i) => i.kind === "turn" && i.ev.seat === seat));
  }

  /** An event, or a state that arrived while one plays. */
  push(item: Item): void {
    this.items.push(item);
    if (this.anim && this.behind()) this.finish(this.anim);
    this.pump();
  }

  clear(): void {
    this.items = [];
    this.anim = null;
  }

  /** Finish what's playing now: its effects if they haven't shown yet, then its state. */
  finish(a: Anim): void {
    if (this.anim !== a) return;
    this.anim = null;
    if (!a.fired) {
      a.fired = true;
      this.hooks.fire(a, true);
    }
    this.hooks.apply(a.item.state);
    this.pump();
  }

  private pump(): void {
    while (!this.anim && this.items.length) {
      const item = this.items.shift()!;
      if (item.kind === "state") {
        this.hooks.apply(item.state);
      } else if (item.kind === "turn") {
        this.hooks.apply(item.state);
        this.hooks.turn(item.ev, item.state);
      } else {
        this.play(item);
      }
    }
  }

  private play(item: Played): void {
    if (!this.hooks.canPlay()) {
      this.hooks.apply(item.state);
      return;
    }
    const ms = playMs(item, item.kind === "act" && item.ev.seat === this.hooks.seat());
    const a: Anim = { item, start: performance.now(), moveMs: ms.moveMs, actionMs: ms.actionMs, fired: false };
    if (this.behind()) {
      // Catching up: show what happened, and move on.
      a.fired = true;
      this.hooks.fire(a, true);
      this.hooks.apply(item.state);
      return;
    }
    // Hurry when events are waiting, and fit a Fast CPU's step into the gap before its next one.
    const waiting = this.backlog();
    let speed = waiting >= 2 ? 0.3 : waiting === 1 ? 0.6 : 1;
    if (fastCpuStep(item)) speed = Math.min(speed, CPU_FAST_MS / (a.moveMs + a.actionMs));
    a.moveMs *= speed;
    a.actionMs *= speed;
    this.anim = a;
    this.hooks.started(a);
    setTimeout(() => {
      if (this.anim !== a) return;
      a.fired = true;
      this.hooks.fire(a, false);
    }, a.moveMs);
    setTimeout(() => this.finish(a), a.moveMs + a.actionMs);
  }
}
