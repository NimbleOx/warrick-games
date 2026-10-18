import { ARENA_H, ARENA_W, HEADINGS } from "../shared/constants";
import { COS, SIN } from "../shared/headings";
import type { Round } from "../shared/sim";

export interface HeadStyle {
  name: string;
  color: string;
  you: boolean;
}

export interface DrawOpts {
  /** Per slot. */
  styles: HeadStyle[];
  /** How far the heads are between their position before the last tick (0) and after it (1). */
  alpha: number;
  /** Names and heading arrows over each head (during the countdown). */
  labels: boolean;
  /** Your own head, drawn ahead of the server (null = no prediction). */
  predicted: Prediction | null;
}

export interface Prediction {
  slot: number;
  /** Points as [x, y, painted] triples; `painted` says whether the segment ending at that point leaves a trail. */
  path: number[];
  /** The predicted head is in a gap. */
  gap: boolean;
}

interface Burst {
  x: number;
  y: number;
  color: string;
  born: number;
}

/** Trails are drawn once onto a layer this many times the arena's size, then scaled onto the screen. */
const TRAIL_SCALE = 2;
const BURST_MS = 700;
const WALL = "#ffd23f";

/**
 * Draws a Round. Trails are permanent, so each tick's new segments go onto an
 * offscreen layer once. The latest tick is held back and drawn live, so the
 * heads can glide smoothly between ticks instead of jumping 30 times a second.
 */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private trail = document.createElement("canvas");
  private tctx: CanvasRenderingContext2D;
  private w: number = ARENA_W;
  private h: number = ARENA_H;
  /** Segments from the latest tick, not yet on the trail layer: [slot, x0, y0, x1, y1]. */
  private pending: number[][] = [];
  private bursts: Burst[] = [];
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.tctx = this.trail.getContext("2d")!;
  }

  resize(cssWidth: number): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(200, Math.round(cssWidth * this.dpr));
    const h = Math.round((w * this.h) / this.w);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** Start drawing a new round from an empty arena. Takes the round or the setup it's built from. */
  reset(round: Pick<Round, "cfg">): void {
    const { w, h } = round.cfg;
    this.w = w;
    this.h = h;
    this.trail.width = w * TRAIL_SCALE;
    this.trail.height = h * TRAIL_SCALE;
    this.tctx.setTransform(TRAIL_SCALE, 0, 0, TRAIL_SCALE, 0, 0);
    this.tctx.lineCap = "round";
    this.tctx.lineJoin = "round";
    this.pending = [];
    this.bursts = [];
    this.resize(this.canvas.clientWidth || this.canvas.width / this.dpr);
  }

  /** Call after every step: commits the previous tick's segments and holds back this one's. */
  afterStep(round: Round, styles: HeadStyle[]): void {
    this.commit(round, styles);
    this.pending = [];
    round.heads.forEach((h, i) => {
      if (round.painted[i]) this.pending.push([i, round.prevX[i], round.prevY[i], h.x, h.y]);
    });
  }

  crash(x: number, y: number, color: string): void {
    this.bursts.push({ x, y, color, born: performance.now() });
  }

  draw(round: Round | null, opts: DrawOpts): void {
    const { ctx, canvas } = this;
    const now = performance.now();
    const k = canvas.width / this.w;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#05060c";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!round) return;

    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.trail, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const a = Math.min(1, Math.max(0, opts.alpha));
    const r = round.cfg.radius;
    ctx.lineWidth = r * 2 + 0.5;
    for (const [i, x0, y0, x1, y1] of this.pending) {
      ctx.strokeStyle = opts.styles[i]?.color ?? "#fff";
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a);
      ctx.stroke();
    }

    // Your own head, drawn where it will be once the server catches up.
    const pred = opts.predicted;
    if (pred) {
      ctx.strokeStyle = opts.styles[pred.slot]?.color ?? "#fff";
      const p = pred.path;
      for (let j = 3; j + 2 < p.length; j += 3) {
        if (!p[j + 2]) continue;
        ctx.beginPath();
        ctx.moveTo(p[j - 3], p[j - 2]);
        ctx.lineTo(p[j], p[j + 1]);
        ctx.stroke();
      }
    }

    round.heads.forEach((h, i) => {
      if (!h.alive) return;
      const style = opts.styles[i];
      let x = round.prevX[i] + (h.x - round.prevX[i]) * a;
      let y = round.prevY[i] + (h.y - round.prevY[i]) * a;
      let gap = h.gap > 0;
      if (pred?.slot === i) {
        x = pred.path[pred.path.length - 3];
        y = pred.path[pred.path.length - 2];
        gap = pred.gap;
      }
      const color = style?.color ?? "#fff";
      const hr = r + 1.6;
      if (gap) {
        // A head in a gap leaves no trail: draw it hollow.
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(x, y, hr, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = "#fff8d6";
        ctx.beginPath();
        ctx.arc(x, y, hr, 0, Math.PI * 2);
        ctx.fill();
      }
      if (style?.you) {
        ctx.strokeStyle = "rgb(255 255 255 / 0.55)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(x, y, hr + 4 + Math.sin(now / 160) * 1.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (opts.labels) this.label(x, y, h.heading, style);
      ctx.lineWidth = r * 2 + 0.5;
    });

    this.drawBursts(now);

    // The walls.
    ctx.strokeStyle = WALL;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, this.w - 2, this.h - 2);
    ctx.globalAlpha = 1;
  }

  private commit(round: Round, styles: HeadStyle[]): void {
    const t = this.tctx;
    t.lineWidth = round.cfg.radius * 2 + 0.5;
    for (const [i, x0, y0, x1, y1] of this.pending) {
      t.strokeStyle = styles[i]?.color ?? "#fff";
      t.beginPath();
      t.moveTo(x0, y0);
      t.lineTo(x1, y1);
      t.stroke();
    }
  }

  private label(x: number, y: number, heading: number, style: HeadStyle | undefined): void {
    const ctx = this.ctx;
    const color = style?.color ?? "#fff";
    // Heading arrow.
    const dx = COS[heading % HEADINGS];
    const dy = SIN[heading % HEADINGS];
    const len = 30;
    const tx = x + dx * len;
    const ty = y + dy * len;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + dx * 8, y + dy * 8);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tx + dx * 6, ty + dy * 6);
    ctx.lineTo(tx - dy * 5, ty + dx * 5);
    ctx.lineTo(tx + dy * 5, ty - dx * 5);
    ctx.closePath();
    ctx.fill();
    // Name, on the side away from the arrow.
    const name = style?.you ? `${style.name} (you)` : (style?.name ?? "");
    // About 12 CSS px on screen, whatever size the arena is drawn at.
    const cssPerUnit = (this.canvas.clientWidth || this.canvas.width / this.dpr) / this.w;
    const size = Math.min(26, Math.max(11, 12 / cssPerUnit));
    ctx.font = `${style?.you ? 600 : 500} ${size.toFixed(1)}px "IBM Plex Mono", ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const ly = y - dy * (size + 10) + (dy > 0.3 ? -4 : 4);
    const lx = x - dx * (size * 2 + 6);
    ctx.lineWidth = size / 3;
    ctx.strokeStyle = "rgb(5 6 12 / 0.85)";
    ctx.strokeText(name, lx, ly);
    ctx.fillText(name, lx, ly);
  }

  private drawBursts(now: number): void {
    const ctx = this.ctx;
    this.bursts = this.bursts.filter((b) => now - b.born < BURST_MS);
    for (const b of this.bursts) {
      const t = (now - b.born) / BURST_MS;
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 2.5 * (1 - t) + 0.5;
      ctx.beginPath();
      ctx.arc(b.x, b.y, 4 + t * 26, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#fff";
      for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * Math.PI * 2 + 0.4;
        const d = 3 + t * 20;
        ctx.fillRect(b.x + Math.cos(ang) * d - 1, b.y + Math.sin(ang) * d - 1, 2, 2);
      }
    }
    ctx.globalAlpha = 1;
  }
}
