/**
 * Drawing a table on a canvas: the playfield (walls, blocks, slingshots, inserts) once into a
 * layer of its own for each size, then every frame the lights, targets, bumpers, the brick, the
 * plunger, flippers and balls, and the trouble that covers them (fog, a swap, a tilt). The same
 * renderer draws your own table at full size and each rival's small, from a `View`.
 */

import { rgba } from "@warrick/kit/client/color";
import { dcos, dsin } from "../shared/dmath";
import { F_BRICK, F_FOG, F_OVER, F_SAVE, F_SHRINK, F_SWAP, F_TILT, type View } from "../shared/protocol";
import { SHRINK } from "../shared/sim";
import {
  BALL_R,
  BRICK_HH,
  BRICK_HW,
  BUMPER,
  DROP,
  GATE,
  RUBBER,
  SLING,
  TABLE,
  TABLE_H,
  TABLE_W,
  TARGET,
  type FlipperSpec,
  type Pt,
} from "../shared/table";

const C = {
  bg: "#07051a",
  field: "#140d38",
  field2: "#0a0724",
  wall: "#39e6ff",
  rubber: "#ff7ad9",
  block: "#1b1250",
  blockEdge: "#8a6cff",
  sling: "#ff3fa4",
  unlit: "#3a2f73",
  lit: "#ffe14d",
  drop: "#ff8a2f",
  target: "#2fd6ff",
  bumperCap: "#ffd23f",
  bumperRing: "#ff3fa4",
  jackpot: "#ff8a2f",
  lock: "#7dff5c",
  save: "#7dff5c",
  brick: "#e8344a",
};

/** A popup over your own table: points, or a word. */
interface Popup {
  x: number;
  y: number;
  text: string;
  at: number;
  color: string;
}

export class TableRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private layer: HTMLCanvasElement | null = null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  /** Table units to CSS pixels, and where the table sits. */
  scale = 1;
  ox = 0;
  oy = 0;
  /** When each bumper, slingshot and standup last fired (your own table only). */
  readonly flashes = [0, 0, 0, 0, 0, 0, 0, 0];
  private popups: Popup[] = [];
  /** The canvas was cleared by a resize and hasn't been drawn since. */
  blank = true;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly mini = false,
  ) {
    this.ctx = canvas.getContext("2d")!;
  }

  /** Fits the canvas to its box. Returns true if it changed (and so was cleared). */
  resize(): boolean {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w === this.w && h === this.h && dpr === this.dpr && this.layer) return false;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.scale = Math.min(w / TABLE_W, h / TABLE_H);
    this.ox = (w - TABLE_W * this.scale) / 2;
    this.oy = (h - TABLE_H * this.scale) / 2;
    this.layer = this.drawLayer();
    this.blank = true;
    return true;
  }

  /** Where a point on the screen (CSS pixels in the canvas) is on the table. */
  toTable(px: number, py: number): Pt {
    return [(px - this.ox) / this.scale, (py - this.oy) / this.scale];
  }

  popup(x: number, y: number, text: string, color = "#ffffff"): void {
    this.popups.push({ x, y, text, at: performance.now(), color });
    if (this.popups.length > 12) this.popups.shift();
  }

  flash(i: number): void {
    this.flashes[i] = performance.now();
  }

  /** Forget the popups and flashes (a new match, or someone else's table). */
  reset(): void {
    this.popups = [];
    this.flashes.fill(0);
  }

  draw(view: View, color: string, now = performance.now()): void {
    if (!this.layer) this.resize();
    const ctx = this.ctx;
    const k = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.layer!, 0, 0);
    ctx.setTransform(k * this.scale, 0, 0, k * this.scale, k * this.ox, k * this.oy);
    this.blank = false;
    const blink = Math.floor(now / 250) % 2 === 0;

    this.lights(view, blink);
    this.targets(view, now);
    this.bumpers(now);
    if (view.flags & F_BRICK) this.brick(view.brickX, view.brickY);
    this.plunger(view.pull);
    const shrink = view.flags & F_SHRINK ? SHRINK : 1;
    const swap = !!(view.flags & F_SWAP);
    TABLE.flippers.forEach((spec, f) => this.flipper(spec, view.flip[f], shrink, swap ? "#ff8a2f" : color));
    for (const b of view.balls) this.ball(b.x, b.y);
    if (!this.mini) this.drawPopups(now);
    if (view.flags & F_FOG) this.fog();
    if (swap && !this.mini) this.label("⇄ SWAPPED", 253, 1000 - 70, 26, "#ff8a2f");
    if (view.flags & F_TILT) this.label("TILT", 253, 520, this.mini ? 140 : 110, "#ff3b3b");
    if (view.flags & F_OVER) {
      ctx.fillStyle = "rgba(5, 3, 18, 0.55)";
      ctx.fillRect(0, 0, TABLE_W, TABLE_H);
      this.label(this.mini ? "OUT" : "GAME OVER", 253, 500, this.mini ? 110 : 60, "#ffffff");
    }
  }

  // ------------------------------------------------------------------ the playfield layer

  private drawLayer(): HTMLCanvasElement {
    const layer = document.createElement("canvas");
    layer.width = this.canvas.width;
    layer.height = this.canvas.height;
    const ctx = layer.getContext("2d")!;
    const k = this.dpr;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, layer.width, layer.height);
    ctx.setTransform(k * this.scale, 0, 0, k * this.scale, k * this.ox, k * this.oy);
    const art = TABLE.art;

    // The playfield, inside the cabinet.
    const g = ctx.createLinearGradient(0, 0, 0, TABLE_H);
    g.addColorStop(0, C.field);
    g.addColorStop(1, C.field2);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(20, TABLE_H);
    ctx.lineTo(20, 280);
    ctx.arc(270, 280, 250, Math.PI, Math.PI * (300 / 180));
    ctx.arc(440, 181.9, 80, Math.PI * (300 / 180), Math.PI * 2);
    ctx.lineTo(520, TABLE_H);
    ctx.closePath();
    ctx.fill();
    if (!this.mini) {
      // A soft glow in the middle, and the name on the glass.
      const glow = ctx.createRadialGradient(253, 560, 20, 253, 560, 300);
      glow.addColorStop(0, "rgba(167, 123, 255, 0.16)");
      glow.addColorStop(1, "rgba(167, 123, 255, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 200, TABLE_W, 700);
      ctx.save();
      ctx.translate(253, 610);
      ctx.rotate(-0.18);
      ctx.font = "700 46px 'Press Start 2P', monospace";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255, 63, 164, 0.08)";
      ctx.fillText("FLIP", 0, -10);
      ctx.fillText("SIDE", 0, 50);
      ctx.restore();
    }
    // The shooter lane.
    ctx.fillStyle = "#0c0828";
    ctx.fillRect(486, 330, 34, TABLE_H - 330);
    // The apron under the flippers.
    ctx.fillStyle = "#0e0a2c";
    ctx.beginPath();
    ctx.moveTo(20, 960);
    ctx.lineTo(486, 960);
    ctx.lineTo(486, TABLE_H);
    ctx.lineTo(20, TABLE_H);
    ctx.fill();

    // Inserts: unlit lights, arrows, words.
    const insert = (p: Pt, r: number) => {
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(58, 47, 115, 0.55)";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = C.unlit;
      ctx.stroke();
    };
    for (const p of art.lanes) insert(p, 7);
    for (const p of art.drops) insert(p, 6);
    for (const p of art.targets) insert(p, 6);
    art.mults.forEach((p, i) => {
      insert(p, 12);
      if (!this.mini) this.text(ctx, `${i + 2}×`, p[0], p[1] + 4, 11, "rgba(160, 150, 220, 0.6)");
    });
    this.arrow(ctx, art.lock, art.scoopDir, 15, "rgba(58, 47, 115, 0.55)", C.unlit);
    this.arrow(ctx, art.orbit, [0, -1], 13, "rgba(58, 47, 115, 0.55)", C.unlit);
    if (!this.mini) this.text(ctx, "BALL SAVE", 253, 988, 13, "rgba(160, 150, 220, 0.35)");

    // Blocks and slingshots.
    for (const pts of art.blocks) this.poly(ctx, pts, C.block, C.blockEdge, 2);
    for (const pts of art.slings) this.poly(ctx, pts, rgba(C.sling, 0.22), C.sling, 2.5);

    // Walls, with a glow.
    const walls = (width: number, alpha: number) => {
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const s of TABLE.segs) {
        if (s.kind === DROP || s.kind === TARGET || s.kind === SLING || s.kind === GATE) continue;
        ctx.strokeStyle = rgba(s.kind === RUBBER ? C.rubber : C.wall, alpha);
        ctx.lineWidth = s.kind === RUBBER ? width * 0.8 : width;
        ctx.beginPath();
        ctx.moveTo(s.ax, s.ay);
        ctx.lineTo(s.bx, s.by);
        ctx.stroke();
      }
    };
    if (!this.mini) walls(9, 0.12);
    walls(this.mini ? 5 : 3.5, this.mini ? 0.9 : 0.95);
    // Gates: a thin flap.
    ctx.setLineDash([4, 4]);
    for (const s of TABLE.segs) {
      if (s.kind !== GATE) continue;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s.ax, s.ay);
      ctx.lineTo(s.bx, s.by);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // Posts.
    for (const c of TABLE.circles) {
      if (c.kind === BUMPER) continue;
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r + 1, 0, Math.PI * 2);
      ctx.fillStyle = c.kind === RUBBER ? C.rubber : "#cfd8ff";
      ctx.fill();
    }
    // The scoop: a hole.
    const sc = TABLE.scoop;
    const hole = ctx.createRadialGradient(sc.x, sc.y, 2, sc.x, sc.y, 18);
    hole.addColorStop(0, "#000");
    hole.addColorStop(1, "#2a1d66");
    ctx.fillStyle = hole;
    ctx.beginPath();
    ctx.arc(sc.x, sc.y, 17, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = C.blockEdge;
    ctx.lineWidth = 2;
    ctx.stroke();
    return layer;
  }

  // ------------------------------------------------------------------ lights and targets

  private lights(v: View, blink: boolean): void {
    const ctx = this.ctx;
    const art = TABLE.art;
    const light = (p: Pt, r: number, color: string) => {
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (!this.mini) {
        ctx.beginPath();
        ctx.arc(p[0], p[1], r * 2.2, 0, Math.PI * 2);
        ctx.fillStyle = rgba(color, 0.18);
        ctx.fill();
      }
    };
    art.lanes.forEach((p, i) => {
      if (v.lanes & (1 << i)) light(p, 7, C.lit);
      else if (i === v.skill && blink) light(p, 7, "#ffffff");
    });
    art.drops.forEach((p, i) => {
      if (v.drops & (1 << i)) light(p, 6, C.drop);
    });
    art.targets.forEach((p, i) => {
      if (v.targets & (1 << i)) light(p, 6, C.target);
    });
    art.mults.forEach((p, i) => {
      if (v.mult >= i + 2) {
        light(p, 12, C.lit);
        if (!this.mini) this.text(ctx, `${i + 2}×`, p[0], p[1] + 4, 11, "#2a1600");
      }
    });
    if (v.jackpot) {
      if (blink || this.mini) this.arrow(ctx, art.lock, art.scoopDir, 15, C.jackpot, "#fff");
      if (!this.mini) this.text(ctx, "JACKPOT", art.lock[0] - 6, art.lock[1] + 36, 13, C.jackpot);
    } else if (v.lockLit) {
      if (blink || this.mini) this.arrow(ctx, art.lock, art.scoopDir, 15, C.lock, "#fff");
      if (!this.mini) this.text(ctx, `LOCK ${v.locks + 1}`, art.lock[0] - 6, art.lock[1] + 36, 13, C.lock);
    }
    if (v.flags & F_SAVE && (blink || this.mini) && !this.mini) this.text(ctx, "BALL SAVE", 253, 988, 13, C.save);
  }

  private targets(v: View, now: number): void {
    const ctx = this.ctx;
    ctx.lineCap = "butt";
    for (const s of TABLE.segs) {
      if (s.kind === DROP) {
        const down = v.drops & (1 << s.id);
        ctx.strokeStyle = down ? "rgba(255, 138, 47, 0.18)" : C.drop;
        ctx.lineWidth = down ? 3 : 8;
      } else if (s.kind === TARGET) {
        const lit = v.targets & (1 << s.id);
        const hit = now - this.flashes[5 + s.id] < 150;
        ctx.strokeStyle = hit ? "#ffffff" : lit ? C.target : rgba(C.target, 0.45);
        ctx.lineWidth = 8;
      } else if (s.kind === SLING) {
        if (now - this.flashes[3 + s.id] > 120) continue;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 5;
      } else continue;
      ctx.beginPath();
      ctx.moveTo(s.ax, s.ay);
      ctx.lineTo(s.bx, s.by);
      ctx.stroke();
    }
  }

  private bumpers(now: number): void {
    const ctx = this.ctx;
    for (const c of TABLE.circles) {
      if (c.kind !== BUMPER) continue;
      const hit = now - this.flashes[c.id] < 140;
      if (!this.mini) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.r + (hit ? 12 : 6), 0, Math.PI * 2);
        ctx.fillStyle = rgba(hit ? "#ffffff" : C.bumperRing, hit ? 0.35 : 0.14);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
      ctx.fillStyle = hit ? "#ffffff" : C.bumperRing;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r * 0.62, 0, Math.PI * 2);
      ctx.fillStyle = hit ? C.bumperCap : "#2a0f3a";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r * 0.38, 0, Math.PI * 2);
      ctx.fillStyle = C.bumperCap;
      ctx.fill();
    }
  }

  private brick(x: number, y: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = C.brick;
    ctx.fillRect(x - BRICK_HW, y - BRICK_HH, BRICK_HW * 2, BRICK_HH * 2);
    if (!this.mini) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - BRICK_HW, y - BRICK_HH, BRICK_HW * 2, BRICK_HH * 2);
      ctx.clip();
      ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
      ctx.lineWidth = 6;
      for (let i = -BRICK_HW - 20; i < BRICK_HW + 20; i += 14) {
        ctx.beginPath();
        ctx.moveTo(x + i, y + BRICK_HH);
        ctx.lineTo(x + i + 22, y - BRICK_HH);
        ctx.stroke();
      }
      ctx.restore();
      ctx.strokeStyle = "#ffb3bd";
      ctx.lineWidth = 2;
      ctx.strokeRect(x - BRICK_HW, y - BRICK_HH, BRICK_HW * 2, BRICK_HH * 2);
    }
  }

  private plunger(pull: number): void {
    const ctx = this.ctx;
    const top = TABLE.plungerY + BALL_R + 1 + pull * 34;
    ctx.fillStyle = "#cfd8ff";
    ctx.fillRect(492, top, 22, 6);
    ctx.fillStyle = "#6b6f9a";
    ctx.fillRect(500, top + 6, 6, TABLE_H - top);
    if (!this.mini && pull > 0) {
      ctx.fillStyle = rgba(C.lit, 0.25 + pull * 0.6);
      ctx.fillRect(523, TABLE_H - 4 - pull * 120, 6, pull * 120);
    }
  }

  private flipper(spec: FlipperSpec, a: number, shrink: number, color: string): void {
    const ctx = this.ctx;
    const len = spec.len * shrink;
    const dx = dcos(a) * spec.side;
    const dy = dsin(a);
    const tx = spec.px + dx * len;
    const ty = spec.py + dy * len;
    // A tapered capsule: the pivot's circle, the tip's, and the lines between them.
    const nx = -dy;
    const ny = dx;
    ctx.beginPath();
    ctx.moveTo(spec.px + nx * spec.r0, spec.py + ny * spec.r0);
    ctx.lineTo(tx + nx * spec.r1, ty + ny * spec.r1);
    // Round the far side of the tip, then the back of the pivot (anticlockwise on screen, for both).
    ctx.arc(tx, ty, spec.r1, Math.atan2(ny, nx), Math.atan2(-ny, -nx), true);
    ctx.lineTo(spec.px - nx * spec.r0, spec.py - ny * spec.r0);
    ctx.arc(spec.px, spec.py, spec.r0, Math.atan2(-ny, -nx), Math.atan2(ny, nx), true);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = this.mini ? 3 : 2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(spec.px, spec.py, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
  }

  private ball(x: number, y: number): void {
    const ctx = this.ctx;
    const r = this.mini ? BALL_R * 1.35 : BALL_R;
    if (this.mini) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      return;
    }
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.45, "#c9cfe6");
    g.addColorStop(1, "#4a4f72");
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
  }

  private fog(): void {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 0, 0, 720);
    g.addColorStop(0, "rgba(9, 6, 28, 0.97)");
    g.addColorStop(0.78, "rgba(9, 6, 28, 0.95)");
    g.addColorStop(1, "rgba(9, 6, 28, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, TABLE_W, 720);
    if (!this.mini) this.text(ctx, "FOG", 253, 360, 40, "rgba(167, 123, 255, 0.5)");
  }

  private drawPopups(now: number): void {
    const ctx = this.ctx;
    this.popups = this.popups.filter((p) => now - p.at < 1100);
    for (const p of this.popups) {
      const t = (now - p.at) / 1100;
      ctx.globalAlpha = 1 - t * t;
      this.text(ctx, p.text, p.x, p.y - 30 - t * 40, 18, p.color);
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------ helpers

  private label(text: string, x: number, y: number, size: number, color: string): void {
    const ctx = this.ctx;
    ctx.font = `${size}px 'Press Start 2P', monospace`;
    ctx.textAlign = "center";
    ctx.lineWidth = size / 6;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  private text(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string): void {
    ctx.font = `700 ${size}px 'IBM Plex Mono', monospace`;
    ctx.textAlign = "center";
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  private poly(ctx: CanvasRenderingContext2D, pts: Pt[], fill: string, edge: string, width: number): void {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineJoin = "round";
    ctx.lineWidth = width;
    ctx.strokeStyle = edge;
    ctx.stroke();
  }

  /** A chevron at `p` pointing along `d`. */
  private arrow(ctx: CanvasRenderingContext2D, p: Pt, d: Pt, size: number, fill: string, edge: string): void {
    const [dx, dy] = d;
    const nx = -dy;
    const ny = dx;
    ctx.beginPath();
    ctx.moveTo(p[0] + dx * size, p[1] + dy * size);
    ctx.lineTo(p[0] - dx * size * 0.7 + nx * size, p[1] - dy * size * 0.7 + ny * size);
    ctx.lineTo(p[0] - dx * size * 0.2, p[1] - dy * size * 0.2);
    ctx.lineTo(p[0] - dx * size * 0.7 - nx * size, p[1] - dy * size * 0.7 - ny * size);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = edge;
    ctx.stroke();
  }
}

/**
 * A rival's table between two frames: balls moved part way (a ball that's just appeared or
 * gone isn't), flippers turned part way, the rest from the newer frame.
 */
export function lerpView(out: View, a: View, b: View, t: number): View {
  out.balls.length = 0;
  for (let i = 0; i < b.balls.length; i++) {
    const p = b.balls[i];
    const q = a.balls[i];
    if (q && Math.abs(q.x - p.x) + Math.abs(q.y - p.y) < 160)
      out.balls.push({ x: q.x + (p.x - q.x) * t, y: q.y + (p.y - q.y) * t });
    else out.balls.push({ x: p.x, y: p.y });
  }
  out.flip[0] = a.flip[0] + (b.flip[0] - a.flip[0]) * t;
  out.flip[1] = a.flip[1] + (b.flip[1] - a.flip[1]) * t;
  out.pull = b.pull;
  out.lanes = b.lanes;
  out.drops = b.drops;
  out.targets = b.targets;
  out.lockLit = b.lockLit;
  out.locks = b.locks;
  out.jackpot = b.jackpot;
  out.skill = b.skill;
  out.flags = b.flags;
  out.brickX = b.brickX;
  out.brickY = b.brickY;
  out.score = b.score;
  out.ball = b.ball;
  out.left = b.left;
  out.mult = b.mult;
  out.power = b.power;
  return out;
}
