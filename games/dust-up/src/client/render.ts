/**
 * The side-on view: sky, parallax hills, the ground, checkpoints, and the bike drawn from its
 * physics bodies. Drawing isn't part of the sim, so it may use trig freely.
 */

import { hexToRgb, mix } from "@warrick/kit/client/color";
import { Bike, TUNE, riderX, riderY, suspension, type Wheel } from "../shared/bike";
import type { Course } from "../shared/ride";

const SKY_TOP = "#6cb6e6";
const SKY_LOW = "#d9eef5";
const HILL_FAR = "#a9c8b4";
const HILL_NEAR = "#86ab83";
const DIRT = "#8a5631";
const DIRT_DEEP = "#5e3820";
const DIRT_EDGE = "#c08a4f";
const DIRT_CRUST = "#6f4326";

export interface BikeLook {
  /** Plastics and helmet. */
  color: string;
  jersey: string;
  alpha: number;
}

/** A rider's colours: plastics in their colour, a jersey in a darker shade of it. */
export function lookFor(color: string, alpha = 1): BikeLook {
  const [r, g, b] = hexToRgb(color);
  const dark = mix([r, g, b], [24, 20, 30], 0.55).map(Math.round);
  return { color, jersey: `rgb(${dark[0]}, ${dark[1]}, ${dark[2]})`, alpha };
}

/** One bike to draw: see-through ones are other riders, drawn behind and labelled with `name`. */
export interface DrawBike {
  bike: Bike;
  look: BikeLook;
  name?: string;
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  readonly cam = { x: 0, y: 0, ppm: 60, ready: false };
  /** A dev aid: draws closer (2) or further out (0.5). */
  zoom = 1;
  /** Nothing drawn since the canvas was last sized (which clears it). */
  blank = true;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    this.ctx = ctx;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  /** Match the canvas to its size on the page. */
  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.blank = true;
  }

  /**
   * Moves the camera towards the bike: it looks ahead and pulls back a little at speed. High in
   * the air it drops towards the ground (at `groundY`, if given), so you can see where you'll land.
   */
  follow(b: Bike, dt: number, groundY?: number): void {
    const speed = Math.hypot(b.vx, b.vy);
    const lookAhead = Math.max(-2, Math.min(6, b.vx * 0.35));
    const tx = b.x + lookAhead;
    const above = groundY === undefined || !Number.isFinite(groundY) ? 0 : Math.max(0, b.y - groundY - 1.5);
    const ty = b.y + 0.6 - Math.min(above * 0.45, 6);
    // About 10 m of ground across the shorter side at a standstill, 16 m at top speed.
    const span = 10 + Math.min(speed, 20) * 0.3;
    const ppm = Math.min(this.w / (span * 1.6), this.h / span) * this.zoom;
    const cam = this.cam;
    if (!cam.ready || Math.abs(tx - cam.x) > 30 || Math.abs(ty - cam.y) > 30) {
      cam.x = tx;
      cam.y = ty;
      cam.ppm = ppm;
      cam.ready = true;
      return;
    }
    const k = 1 - Math.exp(-dt * 5);
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * (1 - Math.exp(-dt * 3.5));
    cam.ppm += (ppm - cam.ppm) * (1 - Math.exp(-dt * 1.5));
  }

  /**
   * The course and its bikes, with `passed` checkpoints shown as passed. See-through bikes (other
   * riders, your best run) go behind, with their names over them.
   */
  draw(course: Course, bikes: DrawBike[], passed: number): void {
    const { ctx, w, h, dpr, cam } = this;
    if (!w || !h) return;
    this.blank = false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawSky();

    // World transform: metres, y up.
    const ox = w / 2 - cam.x * cam.ppm;
    const oy = h * 0.6 + cam.y * cam.ppm;
    ctx.setTransform(dpr * cam.ppm, 0, 0, -dpr * cam.ppm, dpr * ox, dpr * oy);
    const left = cam.x - w / 2 / cam.ppm - 2;
    const right = cam.x + w / 2 / cam.ppm + 2;
    const bottom = cam.y - (h * 0.4) / cam.ppm - 2;

    this.drawMarkers(course, passed, left, right);
    this.drawGround(course, left, right, bottom);
    const behind = bikes.filter((b) => b.look.alpha < 1);
    for (const b of behind) if (b.bike.x > left - 3 && b.bike.x < right + 3) drawBike(ctx, b.bike, b.look);
    for (const b of bikes) if (b.look.alpha >= 1) drawBike(ctx, b.bike, b.look);

    // Names, in screen space.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = "600 12px 'IBM Plex Mono', ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    for (const b of bikes) {
      if (!b.name || b.bike.x < left || b.bike.x > right) continue;
      const sx = ox + b.bike.x * cam.ppm;
      const sy = oy - (b.bike.y + 1.5) * cam.ppm;
      ctx.globalAlpha = Math.min(1, b.look.alpha + 0.35);
      ctx.fillStyle = "rgb(20 12 6 / 0.6)";
      const tw = ctx.measureText(b.name).width;
      ctx.fillRect(sx - tw / 2 - 7, sy - 16, tw + 11, 17);
      // The rider's colour as a bar, and the name in white, which reads on any colour.
      ctx.fillStyle = b.look.color;
      ctx.fillRect(sx - tw / 2 - 7, sy - 16, 3, 17);
      ctx.fillStyle = "#fff";
      ctx.fillText(b.name, sx + 2, sy);
    }
    ctx.globalAlpha = 1;
  }

  private drawSky(): void {
    const { ctx, w, h, cam } = this;
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, SKY_TOP);
    sky.addColorStop(1, SKY_LOW);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    this.drawHills(0.15, h * 0.62, 70, HILL_FAR, 0.013, cam.x);
    this.drawHills(0.35, h * 0.7, 55, HILL_NEAR, 0.027, cam.x + 40);
  }

  private drawHills(parallax: number, baseY: number, amp: number, color: string, freq: number, seed: number): void {
    const { ctx, w, h, cam } = this;
    const shift = (cam.x + seed) * parallax * cam.ppm * 0.4;
    const lift = cam.y * parallax * cam.ppm * 0.4;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let sx = 0; sx <= w + 8; sx += 8) {
      const u = (sx + shift) * freq;
      const y = baseY + lift - amp * (0.6 * Math.sin(u) + 0.3 * Math.sin(u * 2.3 + 1.7) + 0.15 * Math.sin(u * 5.1 + 0.4));
      ctx.lineTo(sx, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
  }

  private drawGround(course: Course, left: number, right: number, bottom: number): void {
    const { ctx } = this;
    const g = course.ground;
    let first = 0;
    while (first < g.n - 1 && g.xs[first + 1] < left) first++;
    let last = first;
    while (last < g.n - 1 && g.xs[last] <= right) last++;

    const path = new Path2D();
    path.moveTo(g.xs[first], bottom - 50);
    for (let i = first; i <= last; i++) path.lineTo(g.xs[i], g.ys[i]);
    path.lineTo(g.xs[last], bottom - 50);
    path.closePath();

    const fill = ctx.createLinearGradient(0, this.cam.y, 0, this.cam.y - 12);
    fill.addColorStop(0, DIRT);
    fill.addColorStop(1, DIRT_DEEP);
    ctx.fillStyle = fill;
    ctx.fill(path);

    // The surface: a lighter band of loose dirt just inside the ground, with a darker crust line.
    const edge = new Path2D();
    edge.moveTo(g.xs[first], g.ys[first]);
    for (let i = first + 1; i <= last; i++) edge.lineTo(g.xs[i], g.ys[i]);
    ctx.save();
    ctx.clip(path);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = DIRT_EDGE;
    ctx.lineWidth = 0.5;
    ctx.stroke(edge);
    ctx.strokeStyle = DIRT_CRUST;
    ctx.lineWidth = 0.08;
    ctx.stroke(edge);
    // Pebbles, placed by a hash of their metre so they stay put.
    ctx.fillStyle = DIRT_DEEP;
    for (let x = Math.floor(left); x <= right; x++) {
      const r = hash(x);
      const top = g.heightAt(x + r);
      if (!Number.isFinite(top)) continue;
      ctx.beginPath();
      ctx.arc(x + r, top - 0.45 - hash(x + 0.5) * 1.6, 0.05 + hash(x + 0.25) * 0.07, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawMarkers(course: Course, passed: number, left: number, right: number): void {
    const { ctx } = this;
    const g = course.ground;
    course.checkpoints.forEach((x, i) => {
      if (x < left || x > right) return;
      const y = g.heightAt(x);
      ctx.strokeStyle = "#e9e3d6";
      ctx.lineWidth = 0.07;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + 2.4);
      ctx.stroke();
      ctx.fillStyle = i === 0 ? "#f2c230" : i <= passed ? "#3fae4a" : "#d9412b";
      ctx.beginPath();
      ctx.moveTo(x, y + 2.4);
      ctx.lineTo(x + 0.8, y + 2.15);
      ctx.lineTo(x, y + 1.9);
      ctx.closePath();
      ctx.fill();
    });
    const fx = course.finishX;
    if (fx >= left && fx <= right) {
      const y = g.heightAt(fx);
      for (const px of [fx - 0.05, fx + 0.05]) {
        ctx.strokeStyle = "#333";
        ctx.lineWidth = 0.08;
        ctx.beginPath();
        ctx.moveTo(px, y);
        ctx.lineTo(px, y + 3.2);
        ctx.stroke();
      }
      const sq = 0.25;
      for (let row = 0; row < 3; row++)
        for (let col = 0; col < 6; col++) {
          ctx.fillStyle = (row + col) % 2 ? "#111" : "#fff";
          ctx.fillRect(fx + col * sq, y + 3.2 - (row + 1) * sq, sq, sq);
        }
    }
  }
}

function hash(x: number): number {
  const s = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Copies a pose between two ticks into `out`, for drawing between them (t from 0 to 1). */
export function lerpBike(out: Bike, a: Bike, b: Bike, t: number): Bike {
  out.copyFrom(b);
  const l = (p: number, q: number) => p + (q - p) * t;
  out.x = l(a.x, b.x);
  out.y = l(a.y, b.y);
  out.vx = l(a.vx, b.vx);
  out.vy = l(a.vy, b.vy);
  const c = l(a.c, b.c);
  const s = l(a.s, b.s);
  const n = Math.hypot(c, s) || 1;
  out.c = c / n;
  out.s = s / n;
  out.lean = l(a.lean, b.lean);
  lerpWheel(out.rear, a.rear, b.rear, t);
  lerpWheel(out.front, a.front, b.front, t);
  return out;
}

function lerpWheel(out: Wheel, a: Wheel, b: Wheel, t: number): void {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  let da = b.a - a.a;
  if (da > Math.PI) da -= Math.PI * 2;
  if (da < -Math.PI) da += Math.PI * 2;
  out.a = a.a + da * t;
}

// ---------------------------------------------------------------------------------------------
// The bike, in world units (metres, y up). Points in the chassis frame: x forward, y up, origin
// at the centre of mass, like the physics.

const PIVOT: P = [-0.12, -0.22];
const PEG: P = [-0.1, -0.26];
const HEAD_TUBE: P = [0.37, 0.28];
const BARS: P = [0.3, 0.48];
type P = [number, number];

export function drawBike(ctx: CanvasRenderingContext2D, b: Bike, look: BikeLook): void {
  const W = (p: P): P => [b.x + b.c * p[0] - b.s * p[1], b.y + b.s * p[0] + b.c * p[1]];
  const poly = (pts: P[], fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const [x, y] = W(p);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
  };
  const line = (a: P, z: P, width: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(z[0], z[1]);
    ctx.stroke();
  };

  ctx.save();
  ctx.globalAlpha = look.alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const R = TUNE.wheelRadius;
  const rearAxle: P = [b.rear.x, b.rear.y];
  const frontAxle: P = [b.front.x, b.front.y];

  drawWheel(ctx, b.rear, R);
  drawWheel(ctx, b.front, R);

  // Swingarm and shock.
  const pivot = W(PIVOT);
  line(pivot, rearAxle, 0.07, "#3a3a40");
  const mid: P = [pivot[0] + (rearAxle[0] - pivot[0]) * 0.45, pivot[1] + (rearAxle[1] - pivot[1]) * 0.45];
  line(W([-0.22, 0.1]), mid, 0.06, "#d8b02a");

  // Fork: the stanchions from the head tube, the sliders up from the axle.
  const fs = suspension(b, 1);
  const head = W(HEAD_TUBE);
  line(head, [head[0] + fs.dx * 0.42, head[1] + fs.dy * 0.42], 0.055, "#c9ccd2");
  line(frontAxle, [frontAxle[0] - fs.dx * 0.42, frontAxle[1] - fs.dy * 0.42], 0.075, "#2b2b30");

  // Engine and frame.
  poly(
    [
      [-0.2, -0.32],
      [0.18, -0.3],
      [0.24, -0.04],
      [-0.12, 0.04],
    ],
    "#4a4a52",
  );
  line(head, W([0.22, -0.24]), 0.05, "#2b2b30");
  line(head, W([-0.12, 0.1]), 0.05, "#2b2b30");
  line(pivot, W([-0.12, 0.1]), 0.05, "#2b2b30");

  // Plastics: rear fender and side panel, tank and shroud, seat, front fender, number plate.
  poly(
    [
      [-0.98, 0.25],
      [-0.5, 0.15],
      [-0.12, 0.13],
      [-0.2, -0.04],
      [-0.46, -0.02],
    ],
    look.color,
  );
  poly(
    [
      [0.02, 0.14],
      [0.34, 0.27],
      [0.3, -0.06],
      [0.1, -0.1],
    ],
    look.color,
  );
  poly(
    [
      [-0.55, 0.2],
      [0.08, 0.2],
      [0.06, 0.15],
      [-0.5, 0.14],
    ],
    "#1d1d22",
  );
  const fenderBase: P = [frontAxle[0] - fs.dx * (R + 0.05), frontAxle[1] - fs.dy * (R + 0.05)];
  const across: P = [-fs.dy, fs.dx];
  ctx.fillStyle = look.color;
  ctx.beginPath();
  ctx.moveTo(fenderBase[0] - across[0] * 0.3, fenderBase[1] - across[1] * 0.3 - 0.0);
  ctx.lineTo(fenderBase[0] + across[0] * 0.25, fenderBase[1] + across[1] * 0.25);
  ctx.lineTo(fenderBase[0] + across[0] * 0.2 - fs.dx * 0.05, fenderBase[1] + across[1] * 0.2 - fs.dy * 0.05);
  ctx.lineTo(fenderBase[0] - across[0] * 0.28 - fs.dx * 0.06, fenderBase[1] - across[1] * 0.28 - fs.dy * 0.06);
  ctx.closePath();
  ctx.fill();
  poly(
    [
      [0.36, 0.3],
      [0.5, 0.36],
      [0.45, 0.12],
      [0.36, 0.14],
    ],
    "#f4f1e8",
  );
  line(W([0.24, 0.5]), W([0.36, 0.46]), 0.04, "#1d1d22");

  drawRider(ctx, b, look, W);
  ctx.restore();
}

function drawWheel(ctx: CanvasRenderingContext2D, wh: Wheel, R: number): void {
  ctx.strokeStyle = "#1c1b1f";
  ctx.lineWidth = 0.09;
  ctx.beginPath();
  ctx.arc(wh.x, wh.y, R - 0.045, 0, Math.PI * 2);
  ctx.stroke();
  // Knobs on the tyre, so its spin shows at a glance.
  ctx.fillStyle = "#1c1b1f";
  for (let k = 0; k < 16; k++) {
    const a = wh.a + (k * Math.PI) / 8;
    ctx.beginPath();
    ctx.arc(wh.x + Math.cos(a) * (R - 0.01), wh.y + Math.sin(a) * (R - 0.01), 0.025, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = "#b9bcc4";
  ctx.lineWidth = 0.025;
  ctx.beginPath();
  ctx.arc(wh.x, wh.y, R - 0.1, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 0.012;
  ctx.beginPath();
  for (let k = 0; k < 12; k++) {
    const a = wh.a + (k * Math.PI) / 6;
    ctx.moveTo(wh.x, wh.y);
    ctx.lineTo(wh.x + Math.cos(a) * (R - 0.1), wh.y + Math.sin(a) * (R - 0.1));
  }
  ctx.stroke();
  ctx.fillStyle = "#6d7079";
  ctx.beginPath();
  ctx.arc(wh.x, wh.y, 0.045, 0, Math.PI * 2);
  ctx.fill();
}

/** A two-bone limb from a to c with bone lengths l1, l2; the joint bends to the side `bend` (1 or -1). */
function joint(a: P, c: P, l1: number, l2: number, bend: number): P {
  const dx = c[0] - a[0];
  const dy = c[1] - a[1];
  const d = Math.min(Math.hypot(dx, dy), l1 + l2 - 1e-4) || 1e-4;
  const ux = dx / d;
  const uy = dy / d;
  const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const off = Math.sqrt(Math.max(0, l1 * l1 - along * along)) * bend;
  return [a[0] + ux * along - uy * off, a[1] + uy * along + ux * off];
}

function drawRider(ctx: CanvasRenderingContext2D, b: Bike, look: BikeLook, W: (p: P) => P): void {
  const t = TUNE;
  const head = W([riderX(b, t.head, t.headLean), riderY(b, t.head, t.headLean)]);
  const hip = W([riderX(b, t.body, t.bodyLean) - 0.05, riderY(b, t.body, t.bodyLean) - 0.12]);
  const local = (p: P): P => [p[0] - b.x, p[1] - b.y];
  // Shoulders sit below and behind the head, in the chassis's own frame.
  const hl = local(head);
  const back: P = [-0.07 * b.c + 0.22 * b.s, -0.07 * b.s - 0.22 * b.c];
  const shoulder: P = [b.x + hl[0] + back[0], b.y + hl[1] + back[1]];
  const peg = W(PEG);
  const bars = W(BARS);
  // Joints bend the same way relative to the bike, whichever way up it is.
  const knee = joint(hip, peg, 0.46, 0.46, 1);
  const elbow = joint(shoulder, bars, 0.31, 0.3, -1);

  const limb = (a: P, j: P, z: P, width: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(j[0], j[1]);
    ctx.lineTo(z[0], z[1]);
    ctx.stroke();
  };
  limb(hip, knee, peg, 0.15, "#2c2f3a");
  ctx.strokeStyle = "#151515";
  ctx.lineWidth = 0.12;
  ctx.beginPath();
  ctx.moveTo(peg[0], peg[1]);
  ctx.lineTo(peg[0] + b.c * 0.08, peg[1] + b.s * 0.08);
  ctx.stroke();
  // Torso.
  ctx.strokeStyle = look.jersey;
  ctx.lineWidth = 0.22;
  ctx.beginPath();
  ctx.moveTo(hip[0], hip[1]);
  ctx.lineTo(shoulder[0], shoulder[1]);
  ctx.stroke();
  limb(shoulder, elbow, bars, 0.1, look.jersey);
  // Helmet with a visor and peak.
  ctx.fillStyle = look.color;
  ctx.beginPath();
  ctx.arc(head[0], head[1], t.head[2], 0, Math.PI * 2);
  ctx.fill();
  const fwd: P = [b.c, b.s];
  const up: P = [-b.s, b.c];
  ctx.fillStyle = "#20242c";
  ctx.beginPath();
  ctx.arc(head[0] + fwd[0] * 0.07, head[1] + fwd[1] * 0.07, 0.075, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = look.color;
  ctx.lineWidth = 0.04;
  ctx.beginPath();
  ctx.moveTo(head[0] + up[0] * 0.1, head[1] + up[1] * 0.1);
  ctx.lineTo(head[0] + fwd[0] * 0.24 + up[0] * 0.07, head[1] + fwd[1] * 0.24 + up[1] * 0.07);
  ctx.stroke();
}
