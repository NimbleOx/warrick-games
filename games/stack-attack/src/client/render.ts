import { COLS, VISIBLE } from "../shared/constants";
import type { Board } from "../shared/engine";
import { SHAPES, type Piece } from "../shared/pieces";
import type { Active } from "./pilot";

/** Cell colours by value: the seven pieces, then garbage. */
export const PIECE_COLORS = ["", "#3ff0e0", "#ffd23f", "#b48cff", "#5ce65c", "#ff4d4d", "#4da6ff", "#ff9a3c", "#5d6488"];

const BG = "#0b0d17";
const WELL = "#0e1122";
const GRID = "rgb(255 255 255 / 0.035)";
const LINE = "#2a3152";
const MUTED = "#8d94b8";
const PIXEL = '"Press Start 2P", monospace';

export interface Popup {
  text: string;
  color: string;
  at: number;
  /** Bigger text for the big moments. */
  big?: boolean;
}

export interface Flash {
  rows: number[];
  at: number;
}

export interface OwnScene {
  board: Board;
  active: Active | null;
  ghostY: number;
  hold: number;
  /** Hold already used on this piece. */
  holdUsed: boolean;
  next: Piece[];
  /** Incoming garbage: all of it, and the part that rises in on the next lock that clears nothing. */
  pending: number;
  armed: number;
  out: boolean;
  /** Finishing place once out. */
  place: number;
  flashes: Flash[];
  popups: Popup[];
  /** Garbage just rose in: shake the board for a moment. */
  bumpAt: number;
}

export interface MiniScene {
  board: Board;
  pending: number;
  out: boolean;
  place: number;
  winner: boolean;
  popups: Popup[];
  /** We just sent this board garbage. */
  hitAt: number;
}

// Own board layout, in cells: hold box, meter, board, next queue.
const HOLD_X = 0.2;
const BOX_W = 4.4;
const METER_X = 4.95;
const METER_W = 0.5;
const BOARD_X = 5.75;
const BOARD_Y = 0.3;
/** Twenty rows plus the bottom half of the first buffer row, where pieces appear. */
const BOARD_H = VISIBLE + 0.5;
const NEXT_X = 16.15;
export const OWN_W = NEXT_X + BOX_W + 0.2;
export const OWN_H = BOARD_Y + BOARD_H + 0.3;

/** The miniature boards: a meter and the twenty visible rows. */
export const MINI_W = 10.8;
export const MINI_H = VISIBLE;

function setup(canvas: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function cell(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string, bevel: boolean): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, s, s);
  if (!bevel || s < 6) return;
  const b = Math.max(1, Math.round(s / 8));
  ctx.fillStyle = "rgb(255 255 255 / 0.32)";
  ctx.fillRect(x, y, s, b);
  ctx.fillRect(x, y, b, s);
  ctx.fillStyle = "rgb(0 0 0 / 0.28)";
  ctx.fillRect(x, y + s - b, s, b);
  ctx.fillRect(x + s - b, y, b, s);
}

/** A piece centred in a box, for hold and next. */
function drawPiece(ctx: CanvasRenderingContext2D, p: Piece, cx: number, cy: number, s: number, color = PIECE_COLORS[p]): void {
  const cells = SHAPES[p][0];
  const xs = cells.map(([x]) => x);
  const ys = cells.map(([, y]) => y);
  const w = Math.max(...xs) - Math.min(...xs) + 1;
  const h = Math.max(...ys) - Math.min(...ys) + 1;
  const ox = cx - (w * s) / 2 - Math.min(...xs) * s;
  const oy = cy - (h * s) / 2 - Math.min(...ys) * s;
  for (const [x, y] of cells) cell(ctx, Math.round(ox + x * s), Math.round(oy + y * s), Math.round(s), color, true);
}

function drawPopups(ctx: CanvasRenderingContext2D, popups: Popup[], cx: number, cy: number, size: number, now: number): void {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let y = cy;
  for (const p of popups) {
    const age = (now - p.at) / 1400;
    if (age < 0 || age > 1) continue;
    const fs = Math.round(size * (p.big ? 1.25 : 0.85));
    ctx.globalAlpha = age < 0.7 ? 1 : 1 - (age - 0.7) / 0.3;
    ctx.font = `${fs}px ${PIXEL}`;
    const yy = y - age * size * 1.2;
    ctx.fillStyle = "#000";
    ctx.fillText(p.text, cx + 2, yy + 2);
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, cx, yy);
    y += fs * 1.6;
  }
  ctx.globalAlpha = 1;
}

/** The player's own board with its hold box, next queue and garbage meter. */
export class OwnView {
  private ctx: CanvasRenderingContext2D;
  private c = 24;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  resize(c: number): void {
    this.c = c;
    this.ctx = setup(this.canvas, Math.round(OWN_W * c), Math.round(OWN_H * c));
  }

  draw(s: OwnScene, now: number): void {
    const { ctx, c } = this;
    const W = OWN_W * c;
    const H = OWN_H * c;
    ctx.clearRect(0, 0, W, H);

    const bump = now - s.bumpAt < 160 ? Math.round(Math.sin((now - s.bumpAt) / 18) * c * 0.15) : 0;
    const bx = Math.round(BOARD_X * c);
    const by = Math.round(BOARD_Y * c) + bump;
    const bw = COLS * c;
    const bh = Math.round(BOARD_H * c);
    const rowTop = (y: number) => by + bh - (y + 1) * c;

    // Hold and next.
    this.box(HOLD_X * c, BOARD_Y * c, "HOLD", 3.4);
    if (s.hold) {
      drawPiece(
        ctx,
        s.hold as Piece,
        (HOLD_X + BOX_W / 2) * c,
        (BOARD_Y + 2.25) * c,
        c * 0.85,
        s.holdUsed ? "#3a4166" : undefined,
      );
    }
    this.box(NEXT_X * c, BOARD_Y * c, "NEXT", 1.15 + s.next.length * 2.6);
    s.next.forEach((p, i) => {
      const size = i === 0 ? c * 0.85 : c * 0.7;
      drawPiece(ctx, p, (NEXT_X + BOX_W / 2) * c, (BOARD_Y + 2.25 + i * 2.6) * c, size);
    });

    // Well and grid.
    ctx.fillStyle = WELL;
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = "rgb(0 0 0 / 0.35)";
    ctx.fillRect(bx, by, bw, c * 0.5);
    ctx.fillStyle = GRID;
    for (let x = 1; x < COLS; x++) ctx.fillRect(bx + x * c, by, 1, bh);
    for (let y = 1; y <= VISIBLE; y++) ctx.fillRect(bx, rowTop(y) + c, bw, 1);

    ctx.save();
    ctx.beginPath();
    ctx.rect(bx, by, bw, bh);
    ctx.clip();
    const top = Math.min(s.board.height(), VISIBLE + 1);
    for (let y = 0; y < top; y++) {
      for (let x = 0; x < COLS; x++) {
        const v = s.board.get(x, y);
        if (v) cell(ctx, bx + x * c, rowTop(y), c, s.out && s.place !== 1 ? "#3a4166" : PIECE_COLORS[v], true);
      }
    }
    const a = s.active;
    if (a && !s.out) {
      ctx.globalAlpha = 0.28;
      for (const [dx, dy] of SHAPES[a.p][a.r]) {
        const x = bx + (a.x + dx) * c;
        const y = rowTop(s.ghostY - dy);
        ctx.fillStyle = PIECE_COLORS[a.p];
        ctx.fillRect(x + 1, y + 1, c - 2, c - 2);
      }
      ctx.globalAlpha = 1;
      for (const [dx, dy] of SHAPES[a.p][a.r]) cell(ctx, bx + (a.x + dx) * c, rowTop(a.y - dy), c, PIECE_COLORS[a.p], true);
    }
    for (const f of s.flashes) {
      const age = (now - f.at) / 260;
      if (age > 1) continue;
      ctx.fillStyle = `rgb(255 255 255 / ${0.85 * (1 - age)})`;
      for (const y of f.rows) ctx.fillRect(bx, rowTop(y) + (c * age) / 2, bw, c * (1 - age));
    }
    ctx.restore();

    // Danger: the stack is near the top.
    const danger = !s.out && s.board.height() + s.armed >= VISIBLE - 3;
    ctx.strokeStyle = danger ? `rgb(255 77 94 / ${0.55 + 0.45 * Math.sin(now / 110)})` : LINE;
    ctx.lineWidth = 2;
    ctx.strokeRect(bx - 1, by - 1, bw + 2, bh + 2);

    // Garbage meter: red rises on the next lock that clears nothing, orange is still arriving.
    const mx = Math.round(METER_X * c);
    const mw = Math.max(3, Math.round(METER_W * c));
    ctx.fillStyle = BG;
    ctx.fillRect(mx, by, mw, bh);
    const bottom = by + bh;
    const armedH = Math.min(s.armed, VISIBLE) * c;
    const pendH = Math.min(s.pending, VISIBLE) * c;
    ctx.fillStyle = "#ff9a3c";
    ctx.fillRect(mx, bottom - pendH, mw, pendH - armedH);
    ctx.fillStyle = `rgb(255 77 94 / ${0.75 + 0.25 * Math.sin(now / 90)})`;
    ctx.fillRect(mx, bottom - armedH, mw, armedH);
    ctx.fillStyle = BG;
    for (let i = 1; i < Math.min(s.pending, VISIBLE); i++) ctx.fillRect(mx, bottom - i * c, mw, 1);

    if (s.out || s.place === 1) {
      ctx.fillStyle = s.place === 1 ? "rgb(8 10 20 / 0.35)" : "rgb(8 10 20 / 0.6)";
      ctx.fillRect(bx, by, bw, bh);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = s.place === 1 ? "#ffd23f" : "#ff4d5e";
      ctx.font = `${Math.round(c * 1.3)}px ${PIXEL}`;
      ctx.fillText(s.place === 1 ? "WINNER" : "K.O.", bx + bw / 2, by + bh * 0.42);
      if (s.place > 1) {
        ctx.fillStyle = "#e9ecf8";
        ctx.font = `${Math.round(c * 0.7)}px ${PIXEL}`;
        ctx.fillText(`#${s.place}`, bx + bw / 2, by + bh * 0.42 + c * 1.6);
      }
    }
    drawPopups(ctx, s.popups, bx + bw / 2, by + bh * 0.3, c * 0.8, now);
  }

  private box(x: number, y: number, label: string, h: number): void {
    const { ctx, c } = this;
    ctx.fillStyle = WELL;
    ctx.fillRect(x, y, BOX_W * c, h * c);
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, BOX_W * c - 2, h * c - 2);
    ctx.fillStyle = MUTED;
    ctx.font = `${Math.max(7, Math.round(c * 0.4))}px ${PIXEL}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(label, x + (BOX_W * c) / 2, y + c * 0.5);
  }
}

/** An opponent's board, small. */
export class MiniView {
  private ctx: CanvasRenderingContext2D;
  private m = 8;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  resize(m: number): void {
    this.m = m;
    this.ctx = setup(this.canvas, Math.round(MINI_W * m), Math.round(MINI_H * m));
  }

  draw(s: MiniScene, now: number): void {
    const { ctx, m } = this;
    const W = MINI_W * m;
    const H = MINI_H * m;
    ctx.clearRect(0, 0, W, H);
    const bx = Math.round(0.8 * m);
    const bw = COLS * m;
    ctx.fillStyle = WELL;
    ctx.fillRect(bx, 0, bw, H);
    const top = Math.min(s.board.height(), VISIBLE);
    for (let y = 0; y < top; y++) {
      for (let x = 0; x < COLS; x++) {
        const v = s.board.get(x, y);
        if (v) cell(ctx, bx + x * m, H - (y + 1) * m, m, s.out && !s.winner ? "#3a4166" : PIECE_COLORS[v], m >= 10);
      }
    }
    // Meter.
    const mw = Math.max(2, Math.round(0.5 * m));
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, mw, H);
    const ph = Math.min(s.pending, VISIBLE) * m;
    ctx.fillStyle = "#ff4d5e";
    ctx.fillRect(0, H - ph, mw, ph);

    const hit = now - s.hitAt;
    const danger = !s.out && s.board.height() >= VISIBLE - 4;
    ctx.lineWidth = 2;
    ctx.strokeStyle = hit < 500 ? `rgb(255 210 63 / ${1 - hit / 500})` : danger ? "#7a2a35" : LINE;
    ctx.strokeRect(bx - 1, 1, bw + 2, H - 2);

    if (s.out) {
      ctx.fillStyle = "rgb(8 10 20 / 0.55)";
      ctx.fillRect(bx, 0, bw, H);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `${Math.max(8, Math.round(m * 1.4))}px ${PIXEL}`;
      ctx.fillStyle = s.winner ? "#ffd23f" : "#ff4d5e";
      ctx.fillText(s.winner ? "WIN" : `#${s.place}`, bx + bw / 2, H / 2);
    }
    drawPopups(ctx, s.popups, bx + bw / 2, H * 0.35, Math.max(7, m * 0.9), now);
  }
}
