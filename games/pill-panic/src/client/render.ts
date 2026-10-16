import { COLOR, KIND, LINK_D, LINK_L, LINK_R, LINK_U, POP, VIRUS, pieceCells, type Bottle, type Garbage } from "../shared/bottle";
import { COLS, POP_TICKS, ROWS, SPAWN_X } from "../shared/constants";

/** Fill, shadow and highlight for red, yellow and blue. */
const PALETTE = [
  null,
  { base: "#ff4d6d", dark: "#a3123a", light: "#ffc2cf" },
  { base: "#ffd23f", dark: "#a17800", light: "#fff4c2" },
  { base: "#4da6ff", dark: "#1450a3", light: "#cfe7ff" },
] as const;

export interface Look {
  /** The frame's clock, in ms, for animations. */
  time: number;
  /** Outline where the capsule would land. */
  ghost: boolean;
  /** Show the next capsule above the bottle. */
  next: boolean;
  /** Attacks waiting to drop in. */
  incoming: Garbage[];
  /** The player's color, for the bottle's rim. */
  accent: string;
  /** Grey the bottle out (topped out, or gone). */
  dim: boolean;
}

/** The bottle's geometry for a given cell size. */
export function bottleSize(cell: number, next: boolean): { w: number; h: number } {
  const g = geometry(cell, next);
  return { w: g.width, h: g.height };
}

function geometry(cell: number, next: boolean) {
  const wall = Math.max(2, Math.round(cell * 0.2));
  const pad = Math.max(2, Math.round(cell * 0.3));
  const neck = Math.round(cell * 1.2);
  const top = (next ? Math.round(cell * 1.5) : Math.round(cell * 0.35)) + neck;
  const x0 = pad + wall;
  const y0 = top + wall;
  return {
    cell,
    wall,
    pad,
    neck,
    x0,
    y0,
    width: COLS * cell + 2 * (wall + pad),
    height: y0 + ROWS * cell + wall + pad,
  };
}

/** Draws one bottle into a canvas, sized for a cell size. */
export class BottleCanvas {
  readonly ctx: CanvasRenderingContext2D;
  private g = geometry(10, false);
  private dpr = 1;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private next: boolean,
  ) {
    this.ctx = canvas.getContext("2d")!;
  }

  resize(cell: number): void {
    cell = Math.max(4, Math.floor(cell));
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.g = geometry(cell, this.next);
    this.canvas.width = Math.round(this.g.width * this.dpr);
    this.canvas.height = Math.round(this.g.height * this.dpr);
    this.canvas.style.width = `${this.g.width}px`;
    this.canvas.style.height = `${this.g.height}px`;
  }

  get cell(): number {
    return this.g.cell;
  }

  draw(b: Bottle, look: Look): void {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.g.width, this.g.height);
    drawBottle(ctx, this.g, b, look);
  }
}

type Geometry = ReturnType<typeof geometry>;

/** Draw a bottle with its top-left corner at (x, y), into any canvas. */
export function paintBottle(ctx: CanvasRenderingContext2D, x: number, y: number, cell: number, b: Bottle, look: Look): void {
  ctx.save();
  ctx.translate(x, y);
  drawBottle(ctx, geometry(cell, look.next), b, look);
  ctx.restore();
}

function drawBottle(ctx: CanvasRenderingContext2D, g: Geometry, b: Bottle, look: Look): void {
  const { cell, wall, x0, y0, neck } = g;
  const w = COLS * cell;
  const h = ROWS * cell;
  const neckX = x0 + (SPAWN_X - 0.35) * cell;
  const neckW = 2.7 * cell;

  // Glass: the body plus the neck the capsules come in through.
  const glass = new Path2D();
  const r = cell * 0.6;
  glass.moveTo(neckX, y0 - neck);
  glass.lineTo(neckX, y0);
  glass.lineTo(x0 + r, y0);
  glass.arcTo(x0, y0, x0, y0 + r, r);
  glass.lineTo(x0, y0 + h - r);
  glass.arcTo(x0, y0 + h, x0 + r, y0 + h, r);
  glass.lineTo(x0 + w - r, y0 + h);
  glass.arcTo(x0 + w, y0 + h, x0 + w, y0 + h - r, r);
  glass.lineTo(x0 + w, y0 + r);
  glass.arcTo(x0 + w, y0, x0 + w - r, y0, r);
  glass.lineTo(neckX + neckW, y0);
  glass.lineTo(neckX + neckW, y0 - neck);

  const inside = ctx.createLinearGradient(0, y0, 0, y0 + h);
  inside.addColorStop(0, "#0e1330");
  inside.addColorStop(1, "#090b1a");
  ctx.fillStyle = inside;
  ctx.fill(glass);

  // Faint grid.
  if (cell >= 12) {
    ctx.strokeStyle = "rgb(120 140 220 / 0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < COLS; x++) {
      ctx.moveTo(x0 + x * cell + 0.5, y0);
      ctx.lineTo(x0 + x * cell + 0.5, y0 + h);
    }
    for (let y = 1; y < ROWS; y++) {
      ctx.moveTo(x0, y0 + y * cell + 0.5);
      ctx.lineTo(x0 + w, y0 + y * cell + 0.5);
    }
    ctx.stroke();
  }

  // Cells.
  const popT = b.phase === "pop" ? 1 - b.timer / POP_TICKS : 0;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = b.cells[y * COLS + x];
      if (!c) continue;
      const px = x0 + x * cell;
      const py = y0 + y * cell;
      if (c & POP) drawPop(ctx, px, py, cell, c, popT);
      else if ((c & KIND) === VIRUS) drawVirus(ctx, px, py, cell, c & COLOR, look.time, x * 7 + y * 3);
      else drawHalf(ctx, px, py, cell, c & COLOR, c & KIND);
    }
  }

  // The falling capsule, and where it would land.
  const p = b.piece;
  if (p && (b.phase === "fall" || b.phase === "dead")) {
    if (look.ghost && b.phase === "fall") {
      const gy = b.ghostY();
      if (gy !== p.y) {
        ctx.save();
        ctx.globalAlpha = 0.22;
        for (const [x, y, c, kind] of pieceCells({ ...p, y: gy })) drawHalf(ctx, x0 + x * cell, y0 + y * cell, cell, c, kind);
        ctx.restore();
      }
    }
    for (const [x, y, c, kind] of pieceCells(p)) drawHalf(ctx, x0 + x * cell, y0 + y * cell, cell, c, kind);
  }

  // Rim, in the player's color.
  ctx.lineWidth = wall;
  ctx.lineJoin = "round";
  ctx.strokeStyle = look.accent;
  ctx.globalAlpha = 0.85;
  ctx.stroke(glass);
  ctx.globalAlpha = 1;
  if (cell >= 10) {
    ctx.lineWidth = Math.max(1, wall * 0.35);
    ctx.strokeStyle = "rgb(255 255 255 / 0.35)";
    ctx.beginPath();
    ctx.moveTo(x0 + cell * 0.25, y0 + cell * 1.2);
    ctx.lineTo(x0 + cell * 0.25, y0 + h * 0.45);
    ctx.stroke();
  }

  // The next capsule, above the neck.
  if (look.next) {
    const [a, c] = b.next;
    const ny = y0 - neck - cell * 1.25;
    drawHalf(ctx, x0 + SPAWN_X * cell, ny, cell, a, LINK_R);
    drawHalf(ctx, x0 + (SPAWN_X + 1) * cell, ny, cell, c, LINK_L);
  }

  // Attacks waiting to drop in, as small halves along the top-left.
  if (look.incoming.length) {
    const halves = look.incoming.flatMap((gb) => gb.p.map(([, c]) => c));
    const s = Math.max(4, cell * 0.55);
    const max = Math.max(1, Math.floor((neckX - x0 - s * 0.4) / (s * 1.1)));
    const iy = y0 - wall - s * 1.15;
    halves.slice(0, max).forEach((c, i) => drawHalf(ctx, x0 + i * s * 1.1, iy, s, c, 0));
    if (halves.length > max && cell >= 10) {
      ctx.fillStyle = "#fff";
      ctx.font = `${Math.round(s * 0.8)}px "IBM Plex Mono", monospace`;
      ctx.textBaseline = "middle";
      ctx.fillText(`+${halves.length - max}`, neckX + neckW + 4, iy + s / 2);
    }
  }

  if (look.dim) {
    ctx.fillStyle = "rgb(8 10 20 / 0.6)";
    ctx.fill(glass);
  }
}

/** Half a capsule, rounded on the side away from its partner. Kind 0 or LONE draws a round pill. */
function drawHalf(ctx: CanvasRenderingContext2D, px: number, py: number, cell: number, color: number, kind: number): void {
  const pal = PALETTE[color];
  if (!pal) return;
  const inset = Math.max(0.5, cell * 0.06);
  const x = px + inset;
  const y = py + inset;
  const s = cell - inset * 2;
  const round = s / 2;
  const small = s * 0.18;
  let radii: [number, number, number, number];
  switch (kind) {
    case LINK_R:
      radii = [round, small, small, round];
      break;
    case LINK_L:
      radii = [small, round, round, small];
      break;
    case LINK_D:
      radii = [round, round, small, small];
      break;
    case LINK_U:
      radii = [small, small, round, round];
      break;
    default:
      radii = [round, round, round, round];
  }
  ctx.beginPath();
  ctx.roundRect(x, y, s, s, radii);
  ctx.fillStyle = pal.base;
  ctx.fill();
  if (cell >= 8) {
    ctx.lineWidth = Math.max(1, cell * 0.06);
    ctx.strokeStyle = pal.dark;
    ctx.stroke();
    ctx.fillStyle = pal.light;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.ellipse(x + s * 0.36, y + s * 0.3, s * 0.18, s * 0.1, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

/** A germ: a bumpy blob with eyes that wiggles in place. */
function drawVirus(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  cell: number,
  color: number,
  time: number,
  phase: number,
): void {
  const pal = PALETTE[color];
  if (!pal) return;
  const cx = px + cell / 2;
  const beat = Math.floor((time + phase * 97) / 380) % 2;
  const cy = py + cell / 2 + (beat ? -cell * 0.03 : cell * 0.03);
  const r = cell * 0.36;
  ctx.beginPath();
  const bumps = 8;
  const turn = beat ? Math.PI / bumps : 0;
  for (let i = 0; i <= bumps * 2; i++) {
    const a = (i / (bumps * 2)) * Math.PI * 2 + turn;
    const rr = i % 2 ? r : r * 1.18;
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = pal.dark;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.88, 0, Math.PI * 2);
  ctx.fillStyle = pal.base;
  ctx.fill();
  if (cell < 9) return;
  // Eyes, looking one way then the other.
  const look = beat ? 1 : -1;
  for (const side of [-1, 1]) {
    const ex = cx + side * r * 0.36;
    const ey = cy - r * 0.12;
    ctx.beginPath();
    ctx.ellipse(ex, ey, r * 0.24, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ex + look * r * 0.08, ey + r * 0.06, r * 0.12, 0, Math.PI * 2);
    ctx.fillStyle = "#10132a";
    ctx.fill();
  }
  // A mean little mouth.
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.3, cy + r * 0.42);
  ctx.quadraticCurveTo(cx, cy + r * (beat ? 0.62 : 0.5), cx + r * 0.3, cy + r * 0.42);
  ctx.strokeStyle = "#10132a";
  ctx.lineWidth = Math.max(1, cell * 0.06);
  ctx.stroke();
}

/** A cell being cleared: it flashes, then bursts. */
function drawPop(ctx: CanvasRenderingContext2D, px: number, py: number, cell: number, c: number, t: number): void {
  const pal = PALETTE[c & COLOR];
  if (!pal) return;
  const cx = px + cell / 2;
  const cy = py + cell / 2;
  ctx.save();
  if (t < 0.35) {
    // Flash white over the piece.
    ctx.globalAlpha = 1;
    if ((c & KIND) === VIRUS) drawVirus(ctx, px, py, cell, c & COLOR, 0, 0);
    else drawHalf(ctx, px, py, cell, c & COLOR, 0);
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(cx, cy, cell * 0.42, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const k = (t - 0.35) / 0.65;
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = pal.light;
    ctx.lineWidth = Math.max(1, cell * 0.1);
    ctx.beginPath();
    ctx.arc(cx, cy, cell * (0.2 + k * 0.45), 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = pal.base;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.4;
      const d = cell * (0.15 + k * 0.5);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, cell * 0.08 * (1 - k * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}
