import { DEFAULT_COLORS } from "@warrick/kit/shared/constants";
import { mulberry32, randomSeed, type Rng } from "@warrick/kit/shared/rng";
import { cpuMove } from "../shared/ai";
import { isOver, newBoard, playLine, type Board } from "../shared/board";
import { BoardView } from "./render";

const SEATS = 4;
const LEVELS = ["normal", "hard", "easy", "hard"] as const;
const COLORS = [0, 1, 3, 4].map((i) => DEFAULT_COLORS[i]);
const LABELS = ["R", "B", "Y", "P"];

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

  constructor(canvas: HTMLCanvasElement) {
    this.view = new BoardView(canvas);
    this.reset(0);
  }

  resize(): void {
    this.view.fit(this.board.w, this.board.h, window.innerWidth, window.innerHeight, { fill: true, maxCell: 120 });
  }

  frame(now: number): void {
    if (now >= this.nextAt) {
      if (isOver(this.board)) this.reset(now);
      else this.move(now);
    }
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
    this.resize();
  }

  private move(now: number): void {
    const e = cpuMove(this.board, SEATS, this.seat, LEVELS[this.seat], this.rng);
    const done = playLine(this.board, e, this.seat);
    this.lineTime[e] = now;
    for (const b of done) this.boxTime[b] = now;
    this.last = e;
    if (!done.length) this.seat = (this.seat + 1) % SEATS;
    this.nextAt = now + (isOver(this.board) ? 3000 : done.length ? 160 : 380);
  }
}
