// Draws the board on a canvas: the hexagonal tray and its 61 holes, the marbles, where the last
// move came from, the marbles you've picked, the arrows for where they can go, and a preview of
// the move under the pointer. Everything is laid out in "board units" (one unit between two
// holes, see hex.ts) and scaled to the canvas; the second player sees the board turned round.
import { hexToRgb, mix, shade } from "@warrick/kit/client/color";
import { CELLS, DIRS, centre, step } from "../shared/hex";
import type { LastMove } from "../shared/protocol";
import { EMPTY, type Shove } from "../shared/rules";

/** The tray's corners, from the middle, in board units. */
export const FRAME_R = 4.92;
/** Board units across and down the whole picture. */
export const SPAN_X = FRAME_R * 2 + 0.3;
export const SPAN_Y = FRAME_R * Math.sqrt(3) + 0.3;

export interface Arrow {
  dir: number;
  /** Where it's drawn, in board units. */
  x: number;
  y: number;
  /** The move that way is legal. */
  ok: boolean;
}

export interface Scene {
  board: readonly number[];
  /** Each seat's marble colour. */
  colors: readonly string[];
  /** Turned round, for the second seat. */
  flip: boolean;
  /** The last move: its marbles get a faint ring, and the holes they left a dot. */
  last?: LastMove | null;
  /** The last move sliding in, 0 to 1. The board is already as it is after it. */
  slide?: number | null;
  selected?: readonly number[];
  selColor?: string;
  arrows?: readonly Arrow[];
  /** The arrow under the pointer: drawn bigger. */
  hot?: number | null;
  /** The move under the pointer, drawn as ghosts where its marbles would go. */
  preview?: { sh: Shove; seat: number } | null;
  /** Arrows and the selection are only plans: it isn't your turn. */
  waiting?: boolean;
}

const BOARD_HI = "#46527a";
const BOARD_LO = "#2a3252";
const RIM = "#5d6a96";
const HOLE = "#1b2139";
const ARROW = "#ffd23f";
const BAD = "#ff4d5e";

const SQ3 = Math.sqrt(3);
/** A direction's step in board units. */
export const STEP = DIRS.map(([q, r]) => ({ x: q + r / 2, y: (r * SQ3) / 2 }));
const CENTRES = Array.from({ length: CELLS }, (_, c) => centre(c));

const ease = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t);

// ------------------------------------------------------------------ marbles

/** Drawn marbles, by colour and size: a gradient sphere is too slow to draw 28 times a frame. */
const sprites = new Map<string, HTMLCanvasElement>();

function sprite(color: string, px: number): HTMLCanvasElement {
  const size = Math.max(4, Math.round(px));
  const key = `${color}:${size}`;
  let c = sprites.get(key);
  if (c) return c;
  if (sprites.size > 64) sprites.clear();
  c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const r = size / 2;
  const dark = mix(hexToRgb(color), [0, 0, 0], 0.55);
  const lum = luminance(color);
  const g = ctx.createRadialGradient(r * 0.68, r * 0.6, r * 0.05, r, r, r);
  g.addColorStop(0, shade(color, lum > 0.6 ? 0.85 : 0.55));
  g.addColorStop(0.35, color);
  g.addColorStop(1, `rgb(${dark.map(Math.round).join(" ")})`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(r, r, r - 0.5, 0, Math.PI * 2);
  ctx.fill();
  // The shine.
  ctx.fillStyle = "rgb(255 255 255 / 0.55)";
  ctx.beginPath();
  ctx.ellipse(r * 0.66, r * 0.55, r * 0.22, r * 0.14, -0.6, 0, Math.PI * 2);
  ctx.fill();
  sprites.set(key, c);
  return c;
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** One marble at board point (x, y), already in canvas pixels. */
function marble(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, rpx: number, alpha = 1): void {
  ctx.globalAlpha = alpha * 0.45;
  ctx.fillStyle = "#05070f";
  ctx.beginPath();
  ctx.ellipse(x + rpx * 0.12, y + rpx * 0.2, rpx * 0.95, rpx * 0.9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = alpha;
  const s = sprite(color, rpx * 2 * (ctx.getTransform().a || 1));
  ctx.drawImage(s, x - rpx, y - rpx, rpx * 2, rpx * 2);
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------------ the board

/**
 * Draw a scene with the board's middle at (cx, cy) and `u` pixels a board unit. The board as it
 * stands without marbles (the tray, the holes) doesn't change, so `drawTray` can be cached.
 */
export function drawScene(ctx: CanvasRenderingContext2D, sc: Scene, cx: number, cy: number, u: number): void {
  const at = (x: number, y: number): [number, number] => (sc.flip ? [cx - x * u, cy - y * u] : [cx + x * u, cy + y * u]);
  const holeAt = (c: number) => at(CENTRES[c].x, CENTRES[c].y);
  const R = 0.44 * u;

  drawTray(ctx, cx, cy, u);

  // Where the last move's marbles came from: a dot in each hole it left empty.
  const last = sc.last;
  if (last && sc.slide == null) {
    ctx.fillStyle = "rgb(255 255 255 / 0.3)";
    for (const c of last.marbles) {
      if (sc.board[c] !== EMPTY) continue;
      const [x, y] = holeAt(c);
      ctx.beginPath();
      ctx.arc(x, y, u * 0.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Marbles. While the last move slides in, its marbles are drawn on their way instead.
  const moving = new Map<number, { from: number; seat: number }>();
  let off: { from: number; seat: number } | null = null;
  const t = sc.slide == null ? 1 : ease(Math.max(0, Math.min(1, sc.slide)));
  if (last && sc.slide != null && sc.slide < 1) {
    for (const c of last.marbles) moving.set(step(c, last.dir), { from: c, seat: last.seat });
    for (const c of last.pushed) {
      const to = step(c, last.dir);
      if (to >= 0) moving.set(to, { from: c, seat: 1 - last.seat });
      else off = { from: c, seat: 1 - last.seat };
    }
  }
  for (let c = 0; c < CELLS; c++) {
    const seat = sc.board[c];
    if (seat === EMPTY || moving.has(c)) continue;
    const [x, y] = holeAt(c);
    marble(ctx, sc.colors[seat] ?? "#888888", x, y, R);
  }
  for (const [to, m] of moving) {
    const a = CENTRES[m.from];
    const b = CENTRES[to];
    const [x, y] = at(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    marble(ctx, sc.colors[m.seat] ?? "#888888", x, y, R);
  }
  if (off && last) {
    // Over the edge: on past the rim, shrinking and fading.
    const a = CENTRES[off.from];
    const d = STEP[last.dir];
    const k = t * 1.5;
    const [x, y] = at(a.x + d.x * k, a.y + d.y * k);
    marble(ctx, sc.colors[off.seat] ?? "#888888", x, y, R * (1 - 0.35 * t), 1 - t * t);
  }

  // The last move's marbles, once they've landed: a faint ring.
  if (last && sc.slide == null) {
    ctx.strokeStyle = "rgb(255 255 255 / 0.45)";
    ctx.lineWidth = Math.max(1, u * 0.045);
    for (const c of [...last.marbles, ...last.pushed]) {
      const to = step(c, last.dir);
      if (to < 0 || sc.board[to] === EMPTY) continue;
      const [x, y] = holeAt(to);
      ctx.beginPath();
      ctx.arc(x, y, R + u * 0.05, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // The move under the pointer: ghosts where the marbles would go.
  if (sc.preview) {
    const { sh, seat } = sc.preview;
    const ghost = (c: number, color: string) => {
      const to = step(c, sh.dir);
      const p = to >= 0 ? CENTRES[to] : { x: CENTRES[c].x + STEP[sh.dir].x, y: CENTRES[c].y + STEP[sh.dir].y };
      const [x, y] = at(p.x, p.y);
      marble(ctx, color, x, y, R, to >= 0 ? 0.5 : 0.35);
      if (to < 0) {
        // Off the board: crossed out.
        ctx.strokeStyle = BAD;
        ctx.lineWidth = Math.max(2, u * 0.08);
        ctx.beginPath();
        ctx.moveTo(x - R * 0.5, y - R * 0.5);
        ctx.lineTo(x + R * 0.5, y + R * 0.5);
        ctx.moveTo(x + R * 0.5, y - R * 0.5);
        ctx.lineTo(x - R * 0.5, y + R * 0.5);
        ctx.stroke();
      }
    };
    for (const c of sh.pushed) ghost(c, sc.colors[1 - seat] ?? "#888888");
    for (const c of sh.marbles) ghost(c, sc.colors[seat] ?? "#888888");
  }

  // Your picked marbles.
  if (sc.selected?.length) {
    ctx.strokeStyle = sc.selColor ?? ARROW;
    ctx.lineWidth = Math.max(2, u * 0.08);
    ctx.globalAlpha = sc.waiting ? 0.6 : 1;
    for (const c of sc.selected) {
      const [x, y] = holeAt(c);
      ctx.beginPath();
      ctx.arc(x, y, R + u * 0.06, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Arrows for where they can go; an illegal one only shows under the pointer, in red.
  for (const a of sc.arrows ?? []) {
    const hot = sc.hot === a.dir;
    if (!a.ok && !hot) continue;
    const [x, y] = at(a.x, a.y);
    const d = STEP[a.dir];
    const ang = Math.atan2(d.y, d.x) + (sc.flip ? Math.PI : 0);
    chevron(ctx, x, y, ang, u * (hot ? 0.3 : 0.22), a.ok ? ARROW : BAD, sc.waiting && a.ok ? 0.55 : 1);
  }
}

/** The tray and its holes. */
export function drawTray(ctx: CanvasRenderingContext2D, cx: number, cy: number, u: number): void {
  const R = FRAME_R * u;
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    const x = cx + R * Math.cos(a);
    const y = cy + R * Math.sin(a);
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  ctx.closePath();
  const g = ctx.createLinearGradient(cx, cy - R, cx, cy + R);
  g.addColorStop(0, BOARD_HI);
  g.addColorStop(1, BOARD_LO);
  ctx.fillStyle = g;
  ctx.lineJoin = "round";
  ctx.strokeStyle = RIM;
  ctx.lineWidth = u * 0.22;
  ctx.stroke();
  ctx.fill();
  ctx.restore();

  const r = 0.34 * u;
  for (let c = 0; c < CELLS; c++) {
    const x = cx + CENTRES[c].x * u;
    const y = cy + CENTRES[c].y * u;
    ctx.fillStyle = HOLE;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // A lit lower lip, so the hole looks sunk in.
    ctx.strokeStyle = "rgb(255 255 255 / 0.08)";
    ctx.lineWidth = Math.max(1, u * 0.04);
    ctx.beginPath();
    ctx.arc(x, y, r, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  }
}

function chevron(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  ang: number,
  s: number,
  color: string,
  alpha: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "rgb(8 10 20 / 0.55)";
  ctx.beginPath();
  ctx.arc(0, 0, s * 1.25, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = s * 0.42;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(-s * 0.35, -s * 0.6);
  ctx.lineTo(s * 0.35, 0);
  ctx.lineTo(-s * 0.35, s * 0.6);
  ctx.stroke();
  ctx.restore();
}

// ------------------------------------------------------------------ the canvas

/** The game's board canvas: sized in CSS pixels, drawn at the screen's pixel density. */
export class BoardView {
  readonly ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  flip = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  /** Make the board `px` CSS pixels wide (and as tall as that makes it). Returns true if it changed. */
  resize(px: number): boolean {
    const w = Math.max(200, Math.floor(px));
    const h = Math.round((w * SPAN_Y) / SPAN_X);
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (w === this.w && this.canvas.width === Math.round(w * dpr)) return false;
    this.w = w;
    this.h = h;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    return true;
  }

  /** CSS pixels a board unit. */
  get unit(): number {
    return this.w / SPAN_X;
  }

  draw(sc: Scene): void {
    this.flip = sc.flip;
    const dpr = this.canvas.width / Math.max(1, this.w);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    drawScene(ctx, sc, this.w / 2, this.h / 2, this.unit);
  }

  /** A point on the page in board units, as the board lies (not as it's shown turned round). */
  toBoard(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const u = r.width / SPAN_X;
    const x = (clientX - r.left - r.width / 2) / u;
    const y = (clientY - r.top - r.height / 2) / u;
    return this.flip ? { x: -x, y: -y } : { x, y };
  }
}
