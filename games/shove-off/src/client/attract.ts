import { mulberry32, randomSeed, type Rng } from "@warrick/kit/shared/rng";
import { chooseMove } from "../shared/ai";
import { COLORS, type LastMove } from "../shared/protocol";
import { MARBLES, TO_WIN, count, newBoard, play, shove, LAYOUT_IDS } from "../shared/rules";
import { SPAN_X, SPAN_Y, drawScene } from "./view";

const STEP_MS = 950;
const SLIDE_MS = 260;
const LEVELS = ["easy", "normal"] as const;

/** Two CPUs playing on a board behind the home screen, over and over. */
export class Attract {
  private ctx: CanvasRenderingContext2D;
  private rng: Rng = mulberry32(randomSeed());
  private board: number[] = [];
  private levels: ("easy" | "normal")[] = [];
  private seat = 0;
  private turns = 0;
  private last: LastMove | null = null;
  private lastAt = 0;
  private nextAt = 0;
  /** The canvas needs drawing; it was drawn mid-slide last frame. */
  private dirty = true;
  private sliding = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    canvas.addEventListener("contextrestored", () => (this.dirty = true));
    this.reset(0);
  }

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
    this.dirty = true;
  }

  /** Called every animation frame: it draws only while a move slides in, and once after. */
  frame(now: number): void {
    if (now >= this.nextAt) this.step(now);
    const sliding = now - this.lastAt < SLIDE_MS;
    if (!this.dirty && !sliding && !this.sliding) return;
    this.dirty = false;
    this.sliding = sliding;
    const { width: w, height: h } = this.canvas;
    if (!w || !h) return;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#0b0d17";
    ctx.fillRect(0, 0, w, h);
    // Big enough to run off the screen: it's a backdrop, not the game.
    const u = Math.max(w / SPAN_X, h / SPAN_Y) * 1.08;
    drawScene(
      ctx,
      {
        board: this.board,
        colors: [COLORS[0], COLORS[1]],
        flip: false,
        last: this.last,
        slide: sliding ? (now - this.lastAt) / SLIDE_MS : null,
      },
      w / 2,
      h / 2,
      u,
    );
  }

  private reset(now: number): void {
    this.board = newBoard(LAYOUT_IDS[Math.floor(this.rng() * LAYOUT_IDS.length)]);
    this.levels = [LEVELS[Math.floor(this.rng() * 2)], LEVELS[Math.floor(this.rng() * 2)]];
    this.seat = 0;
    this.turns = 0;
    this.last = null;
    this.dirty = true;
    this.nextAt = now + 1200;
  }

  private step(now: number): void {
    const over = count(this.board, 0) <= MARBLES - TO_WIN || count(this.board, 1) <= MARBLES - TO_WIN;
    if (over || this.turns >= 240) return this.reset(now);
    const move = chooseMove(this.board, this.seat, this.levels[this.seat], this.rng);
    const sh = move && shove(this.board, this.seat, move);
    if (sh && typeof sh !== "string") {
      play(this.board, this.seat, sh);
      this.last = { seat: this.seat, dir: sh.dir, marbles: sh.marbles, pushed: sh.pushed, off: sh.off };
      this.lastAt = now;
    }
    this.seat = 1 - this.seat;
    this.turns++;
    // Hold a finished board a moment before the next game.
    const done = count(this.board, 0) <= MARBLES - TO_WIN || count(this.board, 1) <= MARBLES - TO_WIN;
    this.nextAt = now + (done ? 3000 : STEP_MS);
  }
}
