import { mulberry32, randomSeed, type Rng } from "@warrick/kit/shared/rng";
import { chooseMove } from "../shared/ai";
import { COLORS, type Placed } from "../shared/protocol";
import { layoutFor, moveCells, newPosition, play, type Position } from "../shared/rules";
import { drawBoard } from "./board";

const STEP_MS = 420;
const FLASH_MS = 400;
/** The gap between frames of a fading flash: every 2nd frame at 60 Hz, every 4th at 120 Hz. */
const FADE_MS = 30;

/** Four CPUs filling a board behind the home screen, over and over. */
export class Attract {
  private ctx: CanvasRenderingContext2D;
  /** The board as it stands, without the flash: drawn once a move, copied in for each flash frame. */
  private still = document.createElement("canvas");
  private stillCtx = this.still.getContext("2d")!;
  private rng: Rng = mulberry32(randomSeed());
  private pos!: Position;
  private moves: Placed[] = [];
  private out: boolean[] = [];
  private turn = 0;
  private nextAt = 0;
  private lastAt = 0;
  /** The board changed since `still` was drawn; the canvas needs drawing; when it last drew, and with a flash. */
  private stale = true;
  private dirty = true;
  private drawnAt = 0;
  private flashDrawn = false;
  /** Where the board sits and how big its squares are, in canvas pixels. */
  private ox = 0;
  private oy = 0;
  private cell = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    canvas.addEventListener("contextrestored", () => (this.dirty = true));
    this.still.addEventListener("contextrestored", () => (this.stale = true));
    this.reset();
  }

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = this.still.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = this.still.height = Math.round(window.innerHeight * dpr);
    this.stale = true;
  }

  /**
   * Called every animation frame. Between moves only the flash on the last piece changes, and
   * the home card blurs whatever is under it, so the board is drawn once a move, off screen. A
   * flash frame (about 30 a second) copies it in and lightens the piece's few squares; then one
   * more frame without the flash, and nothing until the next move.
   */
  frame(now: number): void {
    if (now >= this.nextAt) this.step(now);
    if (this.stale) this.drawStill();
    const t = (now - this.lastAt) / FLASH_MS;
    const last = this.moves[this.moves.length - 1];
    const flashing = !!last && t < 1;
    // The first frame after the flash ends draws the board without it.
    if (!this.dirty && !(flashing ? now - this.drawnAt >= FADE_MS : this.flashDrawn)) return;
    // A window with no size (a hidden pane) has nothing to copy.
    if (!this.still.width || !this.still.height) return;
    this.dirty = false;
    this.flashDrawn = flashing;
    this.drawnAt = now;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.still, 0, 0);
    if (!flashing) return;
    // As drawBoard draws a flash: nothing is drawn over the squares after it here.
    ctx.fillStyle = `rgb(255 255 255 / ${0.55 * (1 - t)})`;
    for (const c of last.cells) {
      const x = c % this.pos.size;
      ctx.fillRect(this.ox + x * this.cell, this.oy + ((c - x) / this.pos.size) * this.cell, this.cell, this.cell);
    }
  }

  private drawStill(): void {
    this.stale = false;
    this.dirty = true;
    const { width: w, height: h } = this.still;
    const ctx = this.stillCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#0b0d17";
    ctx.fillRect(0, 0, w, h);
    const size = this.pos.size;
    // Big enough to run off the screen: it's a backdrop, not the game.
    this.cell = Math.ceil((Math.max(w, h) * 1.05) / size);
    this.ox = Math.round((w - this.cell * size) / 2);
    this.oy = Math.round((h - this.cell * size) / 2);
    drawBoard(
      ctx,
      { size, board: Array.from(this.pos.cells), moves: this.moves, colors: COLORS, starts: [] },
      this.ox,
      this.oy,
      this.cell,
    );
  }

  private reset(): void {
    this.pos = newPosition(layoutFor(4));
    this.moves = [];
    this.out = [false, false, false, false];
    this.turn = 0;
    this.nextAt = performance.now() + 500;
    this.stale = true;
  }

  private step(now: number): void {
    if (this.out.every(Boolean)) return this.reset();
    for (let i = 0; i < 4; i++) {
      const seat = (this.turn + i) % 4;
      if (this.out[seat]) continue;
      const order = [0, 1, 2, 3].filter((s) => !this.out[s]);
      const move = chooseMove(this.pos, seat, this.rng() < 0.5 ? "easy" : "normal", this.rng, order);
      if (!move) {
        this.out[seat] = true;
        continue;
      }
      this.moves.push({ seat, piece: move.piece, cells: moveCells(this.pos.size, move)! });
      this.pos = play(this.pos, seat, move);
      if (!this.pos.trays[seat].length) this.out[seat] = true;
      this.turn = (seat + 1) % 4;
      this.lastAt = now;
      this.stale = true;
      this.nextAt = now + (this.out.every(Boolean) ? 3000 : STEP_MS);
      return;
    }
    // Nobody could move: hold the finished board a moment, then start again.
    this.nextAt = now + 3000;
  }
}
