// Draws the board on a canvas: the grid, the starting squares, the pieces (outlined one by one),
// the last move, your open corners and the ghost of the piece in your hand.
import type { Placed } from "../shared/protocol";
import { EMPTY } from "../shared/rules";

export interface BoardScene {
  size: number;
  board: readonly number[];
  moves: readonly Placed[];
  /** Colour of each seat. */
  colors: readonly string[];
  /** Starting squares still waiting for their seat's first piece. */
  starts: readonly { cell: number; color: string }[];
  /** Your open corners, in your colour; `bright` ones fit the piece you're holding. */
  corners?: { cells: Iterable<number>; bright: ReadonlySet<number> | null; color: string };
  ghost?: { cells: readonly number[]; ok: boolean } | null;
  /** Cells of a piece that just landed, and how far through its flash (0–1). */
  flash?: { cells: readonly number[]; t: number } | null;
  /** Outline the last move. */
  showLast?: boolean;
}

const BG = "#0d1120";
const GRID = "#1a2140";
const FRAME = "#2a3152";
const OK = "#5ce65c";
const BAD = "#ff4d5e";

export function drawBoard(ctx: CanvasRenderingContext2D, sc: BoardScene, ox: number, oy: number, cell: number): void {
  const { size, board, moves } = sc;
  const span = cell * size;
  ctx.fillStyle = BG;
  ctx.fillRect(ox, oy, span, span);

  // Grid.
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < size; i++) {
    const p = Math.round(i * cell) + 0.5;
    ctx.moveTo(ox + p, oy);
    ctx.lineTo(ox + p, oy + span);
    ctx.moveTo(ox, oy + p);
    ctx.lineTo(ox + span, oy + p);
  }
  ctx.stroke();

  // Starting squares: a ring until that seat has played.
  for (const st of sc.starts) {
    if (board[st.cell] !== EMPTY) continue;
    const [x, y] = xy(st.cell, size);
    const cx = ox + (x + 0.5) * cell;
    const cy = oy + (y + 0.5) * cell;
    ctx.strokeStyle = st.color;
    ctx.lineWidth = Math.max(1.5, cell * 0.1);
    ctx.beginPath();
    ctx.arc(cx, cy, cell * 0.32, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = st.color;
    ctx.beginPath();
    ctx.arc(cx, cy, cell * 0.11, 0, Math.PI * 2);
    ctx.fill();
  }

  // Pieces: fill every square, then bevel each piece along its own outline.
  const owner = new Int16Array(size * size).fill(-1);
  moves.forEach((m, i) => m.cells.forEach((c) => (owner[c] = i)));
  for (let c = 0; c < board.length; c++) {
    const seat = board[c];
    if (seat === EMPTY) continue;
    const [x, y] = xy(c, size);
    ctx.fillStyle = sc.colors[seat] ?? "#888";
    ctx.fillRect(ox + x * cell, oy + y * cell, cell + 0.5, cell + 0.5);
  }
  const edge = Math.max(1, cell * 0.09);
  for (let c = 0; c < board.length; c++) {
    if (board[c] === EMPTY) continue;
    const own = owner[c];
    const [x, y] = xy(c, size);
    const same = (nx: number, ny: number) =>
      nx >= 0 && ny >= 0 && nx < size && ny < size && board[ny * size + nx] !== EMPTY && owner[ny * size + nx] === own;
    const px = ox + x * cell;
    const py = oy + y * cell;
    ctx.fillStyle = "rgb(255 255 255 / 0.32)";
    if (!same(x, y - 1)) ctx.fillRect(px, py, cell, edge);
    if (!same(x - 1, y)) ctx.fillRect(px, py, edge, cell);
    ctx.fillStyle = "rgb(0 0 0 / 0.38)";
    if (!same(x, y + 1)) ctx.fillRect(px, py + cell - edge, cell, edge);
    if (!same(x + 1, y)) ctx.fillRect(px + cell - edge, py, edge, cell);
  }
  // A thin dark line between neighbouring pieces, so each one reads on its own.
  ctx.strokeStyle = "rgb(5 7 16 / 0.85)";
  ctx.lineWidth = Math.max(1, cell * 0.06);
  ctx.beginPath();
  for (let c = 0; c < board.length; c++) {
    if (board[c] === EMPTY) continue;
    const [x, y] = xy(c, size);
    if (x + 1 < size && board[c + 1] !== EMPTY && owner[c + 1] !== owner[c]) {
      ctx.moveTo(ox + (x + 1) * cell, oy + y * cell);
      ctx.lineTo(ox + (x + 1) * cell, oy + (y + 1) * cell);
    }
    if (y + 1 < size && board[c + size] !== EMPTY && owner[c + size] !== owner[c]) {
      ctx.moveTo(ox + x * cell, oy + (y + 1) * cell);
      ctx.lineTo(ox + (x + 1) * cell, oy + (y + 1) * cell);
    }
  }
  ctx.stroke();

  if (sc.showLast && moves.length) outline(ctx, moves[moves.length - 1].cells, size, ox, oy, cell, "rgb(255 255 255 / 0.9)", Math.max(1.5, cell * 0.1));

  if (sc.flash && sc.flash.t < 1) {
    ctx.fillStyle = `rgb(255 255 255 / ${0.55 * (1 - sc.flash.t)})`;
    for (const c of sc.flash.cells) {
      const [x, y] = xy(c, size);
      ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
    }
  }

  // Your open corners: small diamonds.
  if (sc.corners) {
    const { bright, color } = sc.corners;
    ctx.fillStyle = color;
    for (const c of sc.corners.cells) {
      if (board[c] !== EMPTY) continue;
      const lit = !bright || bright.has(c);
      ctx.globalAlpha = bright ? (lit ? 1 : 0.28) : 0.7;
      const r = cell * (bright && lit ? 0.24 : 0.17);
      const [x, y] = xy(c, size);
      const cx = ox + (x + 0.5) * cell;
      const cy = oy + (y + 0.5) * cell;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  if (sc.ghost) {
    const color = sc.ghost.ok ? OK : BAD;
    ctx.fillStyle = sc.ghost.ok ? "rgb(92 230 92 / 0.45)" : "rgb(255 77 94 / 0.42)";
    for (const c of sc.ghost.cells) {
      const [x, y] = xy(c, size);
      ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
    }
    outline(ctx, sc.ghost.cells, size, ox, oy, cell, color, Math.max(2, cell * 0.12));
  }

  ctx.strokeStyle = FRAME;
  ctx.lineWidth = 2;
  ctx.strokeRect(ox - 1, oy - 1, span + 2, span + 2);
}

/** Stroke the outside edges of a set of squares. */
function outline(ctx: CanvasRenderingContext2D, cells: readonly number[], size: number, ox: number, oy: number, cell: number, color: string, width: number): void {
  const set = new Set(cells);
  const h = width / 2;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "square";
  const seg = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  };
  ctx.beginPath();
  for (const c of cells) {
    const [x, y] = xy(c, size);
    const l = ox + x * cell + h;
    const t = oy + y * cell + h;
    const r = ox + (x + 1) * cell - h;
    const b = oy + (y + 1) * cell - h;
    if (y === 0 || !set.has(c - size)) seg(l, t, r, t);
    if (y === size - 1 || !set.has(c + size)) seg(l, b, r, b);
    if (x === 0 || !set.has(c - 1)) seg(l, t, l, b);
    if (x === size - 1 || !set.has(c + 1)) seg(r, t, r, b);
  }
  ctx.stroke();
  ctx.lineCap = "butt";
}

function xy(c: number, size: number): [number, number] {
  const x = c % size;
  return [x, (c - x) / size];
}

/** The game's board canvas: sized in CSS pixels, drawn at the screen's pixel density. */
export class BoardView {
  readonly ctx: CanvasRenderingContext2D;
  private css = 0;
  private size = 20;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  /** Make the board `px` CSS pixels square. Returns true if it changed. */
  resize(px: number): boolean {
    px = Math.max(160, Math.floor(px));
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (px === this.css && this.canvas.width === Math.round(px * dpr)) return false;
    this.css = px;
    this.canvas.style.width = `${px}px`;
    this.canvas.style.height = `${px}px`;
    this.canvas.width = Math.round(px * dpr);
    this.canvas.height = Math.round(px * dpr);
    return true;
  }

  get cssSize(): number {
    return this.css;
  }

  /** CSS pixels per square. */
  get cell(): number {
    return (this.css - 4) / this.size;
  }

  draw(sc: BoardScene): void {
    this.size = sc.size;
    const dpr = this.canvas.width / Math.max(1, this.css);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.css, this.css);
    drawBoard(ctx, sc, 2, 2, this.cell);
  }

  /** The square (fractional) under a point on the page. */
  cellAt(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const cell = (r.width - 4) / this.size;
    return { x: (clientX - r.left - 2) / cell, y: (clientY - r.top - 2) / cell };
  }
}
