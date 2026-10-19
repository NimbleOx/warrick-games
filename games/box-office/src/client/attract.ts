import { DEFAULT_COLORS } from "@warrick/kit/shared/constants";
import { mulberry32, randomSeed, type Rng } from "@warrick/kit/shared/rng";
import { cpuMove } from "../shared/ai";
import { isOver, newBoard, playLine, type Board } from "../shared/board";
import { BoardView, SETTLE_MS } from "./render";

const SEATS = 4;
const LEVELS = ["normal", "hard", "easy", "hard"] as const;
const COLORS = [0, 1, 3, 4].map((i) => DEFAULT_COLORS[i]);
const LABELS = ["R", "B", "Y", "P"];
/** The gap between frames while a new line or box animates: every 2nd frame at 60 Hz, every 4th at 120 Hz. */
const FADE_MS = 30;

/** A self-playing game of CPUs behind the home screen. */
export class Attract {
  private view: BoardView;
  private rng: Rng = mulberry32(randomSeed());
  private board!: Board;
  private seat = 0;
  private last = -1;
  private nextAt = 0;
  private lineTime: number[] = [];
  private boxTime: number[] = [];
  /** Something changed since the last draw; until when the last move animates; when it last drew. */
  private dirty = true;
  private settleAt = 0;
  private drawnAt = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.view = new BoardView(canvas);
    canvas.addEventListener("contextrestored", () => (this.dirty = true));
    // The initials are drawn in a web font: draw them again once it's in.
    document.fonts?.addEventListener("loadingdone", () => (this.dirty = true));
    this.reset(0);
  }

  resize(): void {
    // A backdrop under a blur: twice the CSS pixels is plenty, even on a dpr-3 phone.
    this.view.fit(this.board.w, this.board.h, window.innerWidth, window.innerHeight, { fill: true, maxCell: 120, maxDpr: 2 });
    this.dirty = true;
  }

  /**
   * Called every animation frame, but the board only changes a few times a second, and the home
   * card blurs whatever is under it: so draw only when something changed. While a new line or box
   * animates, draw at about 30 frames a second, then once more where it ends.
   */
  frame(now: number): void {
    if (now >= this.nextAt) {
      if (isOver(this.board)) this.reset(now);
      else this.move(now);
    }
    const moving = now < this.settleAt;
    if (!moving && this.settleAt) {
      this.settleAt = 0;
      this.dirty = true;
    }
    if (!this.dirty && !(moving && now - this.drawnAt >= FADE_MS)) return;
    this.dirty = false;
    this.drawnAt = now;
    this.view.draw(
      this.board,
      {
        colors: COLORS,
        labels: LABELS,
        hover: -1,
        hoverColor: COLORS[0],
        preview: false,
        pending: -1,
        last: this.last,
        pulse: [],
        lineTime: this.lineTime,
        boxTime: this.boxTime,
      },
      now,
      0.55,
    );
  }

  private reset(now: number): void {
    this.board = newBoard(9, 6);
    this.seat = 0;
    this.last = -1;
    this.lineTime = [];
    this.boxTime = [];
    this.nextAt = now + 600;
    this.settleAt = 0;
    this.resize();
  }

  private move(now: number): void {
    const e = cpuMove(this.board, SEATS, this.seat, LEVELS[this.seat], this.rng);
    const done = playLine(this.board, e, this.seat);
    this.lineTime[e] = now;
    for (const b of done) this.boxTime[b] = now;
    this.last = e;
    this.settleAt = now + SETTLE_MS;
    this.dirty = true;
    if (!done.length) this.seat = (this.seat + 1) % SEATS;
    this.nextAt = now + (isOver(this.board) ? 3000 : done.length ? 160 : 380);
  }
}
