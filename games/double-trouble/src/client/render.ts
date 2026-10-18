import { ROCK_COST, ROCK_HP } from "../shared/constants";
import type { Board, Dir, MoveResult } from "../shared/engine";

export const PIXEL = '"Press Start 2P", monospace';
const WELL = "#0e1122";
const EMPTY = "#171c34";
const LINE = "#2a3152";
const BG = "#0b0d17";

/** Tile colours by exponent: the original's warm ramp, on a dark board. Past 2048 they turn neon. */
const TILES: [bg: string, fg: string][] = [
  [EMPTY, "#fff"],
  ["#2e3560", "#c9cff0"], // 2
  ["#434a85", "#e9ecff"], // 4
  ["#f2913d", "#241102"], // 8
  ["#f26f3c", "#240902"], // 16
  ["#f04b3e", "#fff1ec"], // 32
  ["#d9214c", "#fff1f4"], // 64
  ["#f4d673", "#2b1e00"], // 128
  ["#f4cc55", "#2b1e00"], // 256
  ["#f4c238", "#2b1e00"], // 512
  ["#ffb31a", "#2b1700"], // 1024
  ["#ffd23f", "#2b1700"], // 2048
  ["#b48cff", "#170833"], // 4096
  ["#3ff0e0", "#03201d"],
  ["#5ce65c", "#062006"],
  ["#4da6ff", "#04162a"],
  ["#ff6bd6", "#2a0420"],
];
const ROCK = "#59607f";
const ROCK_HI = "#767ea3";
const ROCK_LO = "#3a405c";

export function tileColor(v: number): string {
  return TILES[Math.min(v, TILES.length - 1)][0];
}

/** How long each part of a move's animation takes, in ms. */
const SLIDE_MS = 90;
const POP_MS = 150;
const SPAWN_MS = 130;
const LAND_DELAY = SLIDE_MS + 30;
const LAND_MS = 220;
const SHARD_MS = 450;
/** How long a move's animation runs, all of it. */
const ANIM_MS = Math.max(SLIDE_MS + SPAWN_MS, SLIDE_MS + POP_MS, LAND_DELAY + LAND_MS, SLIDE_MS + SHARD_MS);
const POPUP_MS = 1400;

/** Bumped when a web font finishes loading, so text drawn in a fallback font is drawn again. */
let fontsLoaded = 0;
document.fonts?.addEventListener("loadingdone", () => fontsLoaded++);

const popupsShowing = (popups: Popup[], now: number) => popups.some((p) => now >= p.at && now - p.at <= POPUP_MS);

export interface Popup {
  text: string;
  color: string;
  at: number;
  /** Bigger text for the big moments. */
  big?: boolean;
}

/** A move being animated: what the engine said happened, and when. */
export interface Anim extends Pick<MoveResult, "tweens" | "merged" | "hits" | "landed" | "spawn"> {
  at: number;
}

export interface OwnScene {
  board: Board;
  anim: Anim | null;
  /** Rocks on their way, and the part that lands on the next move. */
  pending: number;
  armed: number;
  /** Power toward the next rock, out of ROCK_COST. */
  charge: number;
  /** A rock just went out: flash the meter. */
  firedAt: number;
  out: boolean;
  /** Finishing place once the round is decided for us. */
  place: number;
  popups: Popup[];
  /** Rocks just landed: shake the board. */
  bumpAt: number;
  /** A move that went nowhere: nudge the board that way. */
  nudge: { dir: Dir; at: number } | null;
  /** Before the round starts, the board is dimmed. */
  waiting: boolean;
}

export interface MiniScene {
  board: Board;
  pending: number;
  out: boolean;
  place: number;
  winner: boolean;
  popups: Popup[];
  /** We just sent this board rocks. */
  hitAt: number;
  /** Rocks just landed on it. */
  landAt: number;
}

// The board in tile units: tiles are 1 wide with gaps of GAP around them.
const GAP = 0.12;
export const boardUnits = (size: number) => size * (1 + GAP) + GAP;
// Our own board has a meter each side: rocks coming in on the left, power going out on the right.
const METER_W = 0.26;
const METER_GAP = 0.16;
export const ownWidth = (size: number) => 2 * (METER_W + METER_GAP) + boardUnits(size);
export const ownHeight = (size: number) => boardUnits(size);
// The small boards have just the incoming meter.
const MINI_METER = 0.16;
export const miniWidth = (size: number) => MINI_METER + 0.08 + boardUnits(size);
export const miniHeight = (size: number) => boardUnits(size);

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

const ease = (t: number) => 1 - (1 - t) * (1 - t);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

function label(v: number): string {
  return String(2 ** v);
}

/** One tile, or a rock, with its top-left at (x, y) and side s. */
export function drawTile(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  v: number,
  numbers: boolean,
  cell = 0,
): void {
  const r = Math.max(2, s * 0.09);
  if (v < 0) {
    drawRock(ctx, x, y, s, r, cell, v);
    return;
  }
  const [bg, fg] = TILES[Math.min(v, TILES.length - 1)];
  if (v >= 10) {
    ctx.shadowColor = bg;
    ctx.shadowBlur = s * 0.35;
  }
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(x, y, s, s, r);
  ctx.fill();
  ctx.shadowBlur = 0;
  if (s >= 10) {
    ctx.fillStyle = "rgb(0 0 0 / 0.22)";
    ctx.fillRect(x + r, y + s - Math.max(1, s * 0.06), s - 2 * r, Math.max(1, s * 0.06));
  }
  if (!numbers) return;
  const text = label(v);
  const fs = s * (text.length <= 2 ? 0.34 : text.length === 3 ? 0.28 : text.length === 4 ? 0.22 : 0.18);
  ctx.font = `${Math.round(fs)}px ${PIXEL}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = fg;
  ctx.fillText(text, x + s / 2 + fs * 0.06, y + s / 2 + fs * 0.08);
}

/** A rock: a grey block with a few chips knocked out of it, the same ones every time for a cell. */
function drawRock(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, r: number, cell: number, v: number): void {
  ctx.fillStyle = ROCK_LO;
  ctx.beginPath();
  ctx.roundRect(x, y, s, s, r);
  ctx.fill();
  ctx.fillStyle = ROCK;
  ctx.beginPath();
  ctx.roundRect(x, y, s, s - Math.max(1, s * 0.08), r);
  ctx.fill();
  if (s < 10) return;
  ctx.fillStyle = ROCK_HI;
  ctx.beginPath();
  ctx.roundRect(x + s * 0.12, y + s * 0.1, s * 0.5, s * 0.14, s * 0.07);
  ctx.fill();
  ctx.fillStyle = ROCK_LO;
  const h = (cell * 2654435761) >>> 0;
  for (let i = 0; i < 3; i++) {
    const px = 0.2 + (((h >>> (i * 5)) & 31) / 31) * 0.6;
    const py = 0.38 + (((h >>> (i * 5 + 15)) & 15) / 15) * 0.42;
    const d = s * (0.07 + i * 0.025);
    ctx.fillRect(x + s * px - d / 2, y + s * py - d / 2, d, d);
  }
  // A rock that's been hit but not smashed (when they take more than one hit) shows a crack.
  if (-v < ROCK_HP && s >= 16) {
    ctx.strokeStyle = "#1c2033";
    ctx.lineWidth = Math.max(1, s * 0.04);
    ctx.beginPath();
    ctx.moveTo(x + s * 0.3, y + s * 0.05);
    ctx.lineTo(x + s * 0.45, y + s * 0.45);
    ctx.lineTo(x + s * 0.35, y + s * 0.65);
    ctx.lineTo(x + s * 0.55, y + s * 0.95);
    ctx.stroke();
  }
}

function drawPopups(ctx: CanvasRenderingContext2D, popups: Popup[], cx: number, cy: number, size: number, now: number): void {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let y = cy;
  for (const p of popups) {
    const age = (now - p.at) / POPUP_MS;
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

/** Where cell i's tile goes, in pixels from the board's corner. */
function at(i: number, size: number, u: number): [number, number] {
  const step = (1 + GAP) * u;
  return [GAP * u + (i % size) * step, GAP * u + Math.floor(i / size) * step];
}

/** The player's own board, with the incoming rocks meter on the left and the power meter on the right. */
export class OwnView {
  private ctx: CanvasRenderingContext2D;
  private u = 80;
  private size = 4;
  /** The scene last drawn, and whether it was moving: a board that's sitting still isn't drawn again. */
  private drawn = "";
  private moving = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  resize(u: number, size: number): void {
    this.u = u;
    this.size = size;
    this.ctx = setup(this.canvas, Math.round(ownWidth(size) * u), Math.round(ownHeight(size) * u));
    this.drawn = "";
  }

  draw(s: OwnScene, now: number): void {
    const { ctx, u, size } = this;
    if (s.board.size !== size) return;
    // Danger (pulsing border) and armed rocks (pulsing meter) never sit still.
    const danger = !s.out && s.board.empties().length - s.armed <= 2;
    const moving =
      danger ||
      s.armed > 0 ||
      (!!s.anim && now - s.anim.at < ANIM_MS) ||
      now - s.bumpAt < 220 ||
      (!!s.nudge && now - s.nudge.at < 140) ||
      now - s.firedAt < 400 ||
      popupsShowing(s.popups, now);
    const key = `${s.board.encode()}|${s.pending}|${s.armed}|${s.charge}|${s.out}|${s.place}|${s.waiting}|${fontsLoaded}`;
    // One more frame after moving stops, so whatever was fading out is gone.
    if (!moving && !this.moving && key === this.drawn) return;
    this.drawn = key;
    this.moving = moving;
    const W = ownWidth(size) * u;
    const H = ownHeight(size) * u;
    ctx.clearRect(0, 0, W, H);

    let dx = 0;
    let dy = 0;
    const bump = now - s.bumpAt;
    if (bump >= 0 && bump < 220) dy = Math.sin(bump / 22) * u * 0.06 * (1 - bump / 220);
    if (s.nudge && now - s.nudge.at < 140) {
      const k = Math.sin(((now - s.nudge.at) / 140) * Math.PI) * u * 0.05;
      dx += s.nudge.dir === 1 ? k : s.nudge.dir === 3 ? -k : 0;
      dy += s.nudge.dir === 2 ? k : s.nudge.dir === 0 ? -k : 0;
    }
    const bx = Math.round((METER_W + METER_GAP) * u + dx);
    const by = Math.round(dy);
    const bw = boardUnits(size) * u;

    this.meters(s, bx, bw, H, now);

    ctx.fillStyle = WELL;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bw, u * 0.12);
    ctx.fill();
    for (let i = 0; i < size * size; i++) {
      const [x, y] = at(i, size, u);
      ctx.fillStyle = EMPTY;
      ctx.beginPath();
      ctx.roundRect(bx + x, by + y, u, u, u * 0.09);
      ctx.fill();
    }

    ctx.save();
    if (s.waiting || (s.out && s.place !== 1)) ctx.globalAlpha = 0.45;
    this.tiles(s, bx, by, now);
    ctx.restore();

    // Danger: nearly full, or rocks about to fill it.
    ctx.strokeStyle = danger ? `rgb(255 77 94 / ${0.55 + 0.45 * Math.sin(now / 110)})` : LINE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(bx - 1, by - 1, bw + 2, bw + 2, u * 0.13);
    ctx.stroke();

    if (s.out || s.place) {
      const won = s.place === 1;
      ctx.fillStyle = won ? "rgb(8 10 20 / 0.3)" : "rgb(8 10 20 / 0.55)";
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bw, u * 0.12);
      ctx.fill();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `${Math.round(u * 0.42)}px ${PIXEL}`;
      ctx.fillStyle = "#000";
      // Out of moves, or someone else made the goal tile first.
      const title = won ? "WINNER" : s.out ? "FULL!" : "BEATEN";
      ctx.fillText(title, bx + bw / 2 + 3, by + bw * 0.42 + 3);
      ctx.fillStyle = won ? "#ffd23f" : "#ff4d5e";
      ctx.fillText(title, bx + bw / 2, by + bw * 0.42);
      if (!won && s.place) {
        ctx.fillStyle = "#e9ecf8";
        ctx.font = `${Math.round(u * 0.26)}px ${PIXEL}`;
        ctx.fillText(`#${s.place}`, bx + bw / 2, by + bw * 0.42 + u * 0.6);
      }
    }
    drawPopups(ctx, s.popups, bx + bw / 2, by + bw * 0.28, u * 0.26, now);
  }

  private tiles(s: OwnScene, bx: number, by: number, now: number): void {
    const { ctx, u, size } = this;
    const a = s.anim;
    const t = a ? now - a.at : Infinity;
    if (a && t < SLIDE_MS) {
      const p = ease(t / SLIDE_MS);
      for (const tw of a.tweens) {
        const [x0, y0] = at(tw.from, size, u);
        const [x1, y1] = at(tw.to, size, u);
        drawTile(ctx, bx + x0 + (x1 - x0) * p, by + y0 + (y1 - y0) * p, u, tw.v, true, tw.to);
      }
      return;
    }
    const merged = new Set(a?.merged);
    const landed = new Set(a?.landed);
    for (let i = 0; i < s.board.cells.length; i++) {
      const v = s.board.cells[i];
      if (!v) continue;
      const [x, y] = at(i, size, u);
      let scale = 1;
      let lift = 0;
      let alpha = 1;
      if (a && i === a.spawn) {
        const p = clamp01((t - SLIDE_MS) / SPAWN_MS);
        if (p <= 0) continue;
        scale = 0.3 + 0.7 * ease(p);
      } else if (a && merged.has(i)) {
        const p = clamp01((t - SLIDE_MS) / POP_MS);
        scale = 1 + 0.16 * Math.sin(p * Math.PI);
      } else if (a && landed.has(i)) {
        const p = clamp01((t - LAND_DELAY) / LAND_MS);
        if (p <= 0) continue;
        lift = (1 - ease(p)) * u * 0.7;
        alpha = p;
        scale = 1 + (1 - p) * 0.25;
      }
      const sz = u * scale;
      ctx.save();
      ctx.globalAlpha *= alpha;
      drawTile(ctx, bx + x + (u - sz) / 2, by + y + (u - sz) / 2 - lift, sz, v, true, i);
      ctx.restore();
    }
    // Rocks smashed: chips flying out.
    if (a && t < SLIDE_MS + SHARD_MS) {
      const p = clamp01((t - SLIDE_MS) / SHARD_MS);
      for (const h of a.hits) {
        const [x, y] = at(h.cell, size, u);
        const cx = bx + x + u / 2;
        const cy = by + y + u / 2;
        if (h.hp > 0) continue;
        ctx.globalAlpha = 1 - p;
        for (let k = 0; k < 7; k++) {
          const ang = (k / 7) * Math.PI * 2 + h.cell;
          const dist = u * (0.15 + 0.55 * ease(p));
          const d = u * (0.16 - 0.08 * p);
          ctx.fillStyle = k % 2 ? ROCK_HI : ROCK;
          ctx.fillRect(cx + Math.cos(ang) * dist - d / 2, cy + Math.sin(ang) * dist + p * p * u * 0.5 - d / 2, d, d);
        }
        ctx.globalAlpha = 1;
      }
    }
  }

  /** Rocks coming in (orange on their way, red landing next move), and power going out. */
  private meters(s: OwnScene, bx: number, bw: number, H: number, now: number): void {
    const { ctx, u, size } = this;
    const mw = Math.max(4, METER_W * u);
    const slots = size * size;
    const seg = H / slots;
    const lx = bx - METER_GAP * u - mw;
    ctx.fillStyle = BG;
    ctx.fillRect(lx, 0, mw, H);
    const shown = Math.min(s.pending, slots);
    for (let i = 0; i < shown; i++) {
      const armed = i < s.armed;
      ctx.fillStyle = armed ? `rgb(255 77 94 / ${0.75 + 0.25 * Math.sin(now / 90)})` : "#ff9a3c";
      ctx.fillRect(lx, H - (i + 1) * seg + 1, mw, seg - 2);
    }

    const rx = bx + bw + METER_GAP * u;
    ctx.fillStyle = BG;
    ctx.fillRect(rx, 0, mw, H);
    const fired = now - s.firedAt;
    const fill = (s.charge / ROCK_COST) * H;
    ctx.fillStyle = fired < 250 ? "#ffffff" : "#ff6bd6";
    ctx.fillRect(rx, H - fill, mw, fill);
    ctx.fillStyle = BG;
    for (let i = 1; i < ROCK_COST; i++) ctx.fillRect(rx, Math.round((H * i) / ROCK_COST), mw, 1);
    if (fired < 400) {
      ctx.fillStyle = `rgb(255 107 214 / ${0.5 * (1 - fired / 400)})`;
      ctx.fillRect(rx - 3, 0, mw + 6, H);
    }
  }
}

/** Someone else's board, small. */
export class MiniView {
  private ctx: CanvasRenderingContext2D;
  private u = 20;
  private size = 4;
  /** The scene last drawn, and whether it was moving: a board that's sitting still isn't drawn again. */
  private drawn = "";
  private moving = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  resize(u: number, size: number): void {
    this.u = u;
    this.size = size;
    this.ctx = setup(this.canvas, Math.round(miniWidth(size) * u), Math.round(miniHeight(size) * u));
    this.drawn = "";
  }

  draw(s: MiniScene, now: number): void {
    const { ctx, u, size } = this;
    if (s.board.size !== size) return;
    const moving = now - s.hitAt < 500 || now - s.landAt < 400 || popupsShowing(s.popups, now);
    const key = `${s.board.encode()}|${s.pending}|${s.out}|${s.place}|${s.winner}|${fontsLoaded}`;
    // One more frame after moving stops, so whatever was fading out is gone.
    if (!moving && !this.moving && key === this.drawn) return;
    this.drawn = key;
    this.moving = moving;
    const W = miniWidth(size) * u;
    const H = miniHeight(size) * u;
    ctx.clearRect(0, 0, W, H);
    const mw = Math.max(2, MINI_METER * u);
    const bx = Math.round(mw + 0.08 * u);
    const bw = boardUnits(size) * u;

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, mw, H);
    const seg = H / (size * size);
    ctx.fillStyle = "#ff4d5e";
    for (let i = 0; i < Math.min(s.pending, size * size); i++) ctx.fillRect(0, H - (i + 1) * seg + 1, mw, seg - 2);

    ctx.fillStyle = WELL;
    ctx.beginPath();
    ctx.roundRect(bx, 0, bw, H, u * 0.12);
    ctx.fill();
    const numbers = u >= 22;
    ctx.save();
    if (s.out && !s.winner) ctx.globalAlpha = 0.45;
    for (let i = 0; i < size * size; i++) {
      const [x, y] = at(i, size, u);
      const v = s.board.cells[i];
      if (v) drawTile(ctx, bx + x, y, u, v, numbers, i);
      else {
        ctx.fillStyle = EMPTY;
        ctx.fillRect(bx + x, y, u, u);
      }
    }
    ctx.restore();

    const hit = now - s.hitAt;
    const land = now - s.landAt;
    const danger = !s.out && s.board.empties().length <= 2;
    ctx.lineWidth = 2;
    ctx.strokeStyle =
      hit < 500
        ? `rgb(255 107 214 / ${1 - hit / 500})`
        : land < 400
          ? `rgb(255 154 60 / ${1 - land / 400})`
          : danger
            ? "#7a2a35"
            : LINE;
    ctx.beginPath();
    ctx.roundRect(bx - 1, 1, bw + 2, H - 2, u * 0.13);
    ctx.stroke();

    if (s.out || s.place) {
      ctx.fillStyle = "rgb(8 10 20 / 0.5)";
      ctx.fillRect(bx, 0, bw, H);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `${Math.max(8, Math.round(u * 0.42))}px ${PIXEL}`;
      ctx.fillStyle = s.winner ? "#ffd23f" : "#ff4d5e";
      ctx.fillText(s.winner ? "WIN" : `#${s.place}`, bx + bw / 2, H / 2);
    }
    drawPopups(ctx, s.popups, bx + bw / 2, H * 0.35, Math.max(7, u * 0.3), now);
  }
}
