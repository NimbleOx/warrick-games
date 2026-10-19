import { NONE, geometry, type Board } from "../shared/board";

/** What to draw on top of the board itself. */
export interface Overlay {
  /** Each seat's colour and initial. */
  colors: string[];
  labels: string[];
  /** A line under the pointer, in `hoverColor`; dashed while it waits for a confirming tap. */
  hover: number;
  hoverColor: string;
  preview: boolean;
  /** A line sent to the server and not yet confirmed. */
  pending: number;
  /** The last line drawn, highlighted. */
  last: number;
  /** Boxes the player to move can complete. */
  pulse: number[];
  /** When each line and box appeared (performance.now()), for the grow and pop animations. */
  lineTime: number[];
  boxTime: number[];
}

const GRID = "#262c4a";
const DOT = "#d8ddf5";
const LINE_MS = 130;
const BOX_MS = 220;
/** How long a new line or box keeps animating. */
export const SETTLE_MS = Math.max(LINE_MS, BOX_MS);

/**
 * The board on a canvas. A board that's wider than tall is drawn on its side when the space
 * for it is taller than wide (a phone in portrait), and input maps back the same way.
 */
export class BoardView {
  readonly ctx: CanvasRenderingContext2D;
  transposed = false;
  /** CSS pixels per box, and where dot (0, 0) sits. */
  cell = 40;
  ox = 0;
  oy = 0;
  cssW = 0;
  cssH = 0;
  private dpr = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  /**
   * Size the canvas for a w × h board in the space given. With `fill`, the canvas takes the
   * whole space and the board sits in the middle (the home screen's backdrop).
   */
  fit(w: number, h: number, availW: number, availH: number, opts: { fill?: boolean; maxCell?: number } = {}): void {
    this.transposed = w > h && availH > availW * 1.05;
    const cols = this.transposed ? h : w;
    const rows = this.transposed ? w : h;
    const cell = Math.floor(Math.min(availW / (cols + 1.1), availH / (rows + 1.1), opts.maxCell ?? 84));
    this.cell = Math.max(18, cell);
    const pad = Math.round(this.cell * 0.55);
    const boardW = cols * this.cell;
    const boardH = rows * this.cell;
    this.cssW = opts.fill ? Math.round(availW) : boardW + 2 * pad;
    this.cssH = opts.fill ? Math.round(availH) : boardH + 2 * pad;
    this.ox = Math.round((this.cssW - boardW) / 2);
    this.oy = Math.round((this.cssH - boardH) / 2);
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
  }

  /** Board units (x across, y down, in boxes) to canvas CSS pixels. */
  toScreen(x: number, y: number): [number, number] {
    return this.transposed
      ? [this.ox + y * this.cell, this.oy + x * this.cell]
      : [this.ox + x * this.cell, this.oy + y * this.cell];
  }

  toBoard(sx: number, sy: number): [number, number] {
    const a = (sx - this.ox) / this.cell;
    const b = (sy - this.oy) / this.cell;
    return this.transposed ? [b, a] : [a, b];
  }

  /**
   * The undrawn line nearest a point on the page, within `reach` boxes of it. Returns the line
   * and how far away it is, in boxes.
   */
  nearest(board: Board, clientX: number, clientY: number, reach = 0.5): { edge: number; dist: number } | null {
    const r = this.canvas.getBoundingClientRect();
    const [x, y] = this.toBoard(clientX - r.left, clientY - r.top);
    if (x < -reach || y < -reach || x > board.w + reach || y > board.h + reach) return null;
    const g = geometry(board.w, board.h);
    let best: { edge: number; dist: number } | null = null;
    for (let e = 0; e < g.edgeCount; e++) {
      if (board.lines[e] !== NONE) continue;
      const [x0, y0, x1, y1] = g.ends[e];
      // Edges are unit segments along one axis.
      const dx = x0 === x1 ? Math.abs(x - x0) : Math.max(0, Math.min(x0, x1) - x, x - Math.max(x0, x1));
      const dy = y0 === y1 ? Math.abs(y - y0) : Math.max(0, Math.min(y0, y1) - y, y - Math.max(y0, y1));
      const dist = Math.hypot(dx, dy);
      if (dist <= reach && (!best || dist < best.dist)) best = { edge: e, dist };
    }
    return best;
  }

  draw(board: Board, o: Overlay, now: number, alpha = 1): void {
    const { ctx, cell } = this;
    const g = geometry(board.w, board.h);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.globalAlpha = alpha;
    const lineW = Math.max(3, Math.round(cell * 0.09));

    // Boxes: claimed ones in their owner's colour, with an initial; ones you can take pulse.
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `600 ${Math.round(cell * 0.44)}px "IBM Plex Mono", ui-monospace, monospace`;
    const pulse = new Set(o.pulse);
    for (let b = 0; b < g.boxCount; b++) {
      const r = Math.floor(b / board.w);
      const c = b % board.w;
      const [cx, cy] = this.toScreen(c + 0.5, r + 0.5);
      const owner = board.boxes[b];
      if (owner >= 0) {
        const t = Math.min(1, (now - (o.boxTime[b] ?? 0)) / BOX_MS);
        const s = (cell - lineW) * (0.55 + 0.45 * easeOut(t));
        const color = o.colors[owner] ?? "#888";
        ctx.globalAlpha = alpha * 0.3;
        ctx.fillStyle = color;
        ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
        if (t < 1) {
          ctx.globalAlpha = alpha * 0.5 * (1 - t);
          ctx.fillStyle = "#fff";
          ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
        }
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.fillText(o.labels[owner] ?? "", cx, cy + 1);
      } else if (pulse.has(b)) {
        ctx.globalAlpha = alpha * (0.2 + 0.14 * Math.sin(now / 160));
        ctx.fillStyle = o.hoverColor;
        const s = cell - lineW * 2;
        ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
        ctx.globalAlpha = alpha;
      }
    }

    // Lines: the grid faintly, then the drawn ones in their drawer's colour.
    ctx.lineCap = "round";
    for (let e = 0; e < g.edgeCount; e++) {
      if (board.lines[e] !== NONE) continue;
      this.segment(g.ends[e], GRID, 2);
    }
    if (o.pending >= 0 && board.lines[o.pending] === NONE) {
      ctx.globalAlpha = alpha * 0.55;
      this.segment(g.ends[o.pending], o.hoverColor, lineW);
      ctx.globalAlpha = alpha;
    }
    if (o.hover >= 0 && board.lines[o.hover] === NONE && o.hover !== o.pending) {
      ctx.globalAlpha = alpha * (o.preview ? 0.7 + 0.3 * Math.sin(now / 120) : 0.75);
      if (o.preview) ctx.setLineDash([lineW * 1.2, lineW * 1.4]);
      this.segment(g.ends[o.hover], o.hoverColor, lineW);
      ctx.setLineDash([]);
      ctx.globalAlpha = alpha;
    }
    for (let e = 0; e < g.edgeCount; e++) {
      const seat = board.lines[e];
      if (seat === NONE) continue;
      const t = Math.min(1, (now - (o.lineTime[e] ?? 0)) / LINE_MS);
      const color = o.colors[seat] ?? "#9aa0c0";
      if (e === o.last) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 14;
        this.segment(g.ends[e], color, lineW + 2, t);
        ctx.shadowBlur = 0;
        this.segment(g.ends[e], "rgba(255,255,255,0.75)", Math.max(1, lineW / 3), t);
      } else {
        this.segment(g.ends[e], color, lineW, t);
      }
    }

    // Dots on top.
    ctx.fillStyle = DOT;
    const dot = Math.max(2.5, cell * 0.075);
    for (let y = 0; y <= board.h; y++) {
      for (let x = 0; x <= board.w; x++) {
        const [sx, sy] = this.toScreen(x, y);
        ctx.beginPath();
        ctx.arc(sx, sy, dot, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  private segment([x0, y0, x1, y1]: [number, number, number, number], color: string, width: number, t = 1): void {
    const ctx = this.ctx;
    const [ax, ay] = this.toScreen(x0, y0);
    const [bx, by] = this.toScreen(x1, y1);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + (bx - ax) * easeOut(t), ay + (by - ay) * easeOut(t));
    ctx.stroke();
  }
}

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}
