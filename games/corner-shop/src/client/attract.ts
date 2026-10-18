import { mulberry32, randomSeed, type Rng } from "@warrick/kit/shared/rng";
import { chooseMove } from "../shared/ai";
import { COLORS, type Placed } from "../shared/protocol";
import { layoutFor, moveCells, newPosition, play, type Position } from "../shared/rules";
import { drawBoard } from "./board";

const STEP_MS = 420;

/** Four CPUs filling a board behind the home screen, over and over. */
export class Attract {
  private ctx: CanvasRenderingContext2D;
  private rng: Rng = mulberry32(randomSeed());
  private pos!: Position;
  private moves: Placed[] = [];
  private out: boolean[] = [];
  private turn = 0;
  private nextAt = 0;
  private lastAt = 0;
  private dirty = true;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.reset();
  }

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
    this.dirty = true;
  }

  frame(now: number): void {
    if (now >= this.nextAt) this.step(now);
    if (!this.dirty && now - this.lastAt > 400) return;
    this.dirty = false;
    const { width: w, height: h } = this.canvas;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#0b0d17";
    ctx.fillRect(0, 0, w, h);
    const size = this.pos.size;
    // Big enough to run off the screen: it's a backdrop, not the game.
    const cell = Math.ceil((Math.max(w, h) * 1.05) / size);
    const last = this.moves[this.moves.length - 1];
    drawBoard(
      ctx,
      {
        size,
        board: Array.from(this.pos.cells),
        moves: this.moves,
        colors: COLORS,
        starts: [],
        flash: last ? { cells: last.cells, t: Math.min(1, (now - this.lastAt) / 400) } : null,
      },
      Math.round((w - cell * size) / 2),
      Math.round((h - cell * size) / 2),
      cell,
    );
  }

  private reset(): void {
    this.pos = newPosition(layoutFor(4));
    this.moves = [];
    this.out = [false, false, false, false];
    this.turn = 0;
    this.nextAt = performance.now() + 500;
    this.dirty = true;
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
      this.dirty = true;
      this.nextAt = now + (this.out.every(Boolean) ? 3000 : STEP_MS);
      return;
    }
    // Nobody could move: hold the finished board a moment, then start again.
    this.nextAt = now + 3000;
  }
}
