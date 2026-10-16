import { Battle, clash, type Group } from "../shared/battle";
import { CAP, HELI, RADIUS, TANK, type SendPct } from "../shared/constants";
import type { GameMap } from "../shared/map";

/** How a slot looks on the map. */
export interface Look {
  color: string;
  name: string;
}

export interface Scene {
  battle: Battle;
  /** By slot; null for an empty slot. */
  looks: (Look | null)[];
  /** The viewer's slot, or -1 when watching. */
  me: number;
  /** The tick to draw, with a fraction, so units glide between frames. */
  t: number;
  selected: number[];
  /** The base under the pointer, or -1. */
  hover: number;
  /** The pointer while dragging out an order (screen px), or null. */
  aim: { x: number; y: number } | null;
  pct: SendPct;
}

const GROUND = "#1a2116";
const GRID = "rgba(255, 255, 240, 0.035)";
const NEUTRAL = "#8b9180";
const NEUTRAL_FILL = "#2b3127";
const ROAD_EDGE = "#11160e";
const ROAD = "#3d4734";
const ROAD_LINE = "rgba(214, 222, 190, 0.22)";
const FONT = "'IBM Plex Mono', ui-monospace, monospace";
/** Helicopter counts are drawn in this colour. */
const HELI_INK = "#a9d8ff";
/** Bases are never drawn smaller than this (CSS px), so they stay easy to hit with a finger. */
const MIN_RADIUS = 11;
/** Extra reach around a base for taps and drops. */
const PICK_SLOP = 16;
const PAD = 14;

/** Which way round to draw a map in a box, and how big. Portrait boxes get the map turned on its side. */
export function fitMap(boxW: number, boxH: number, map: { w: number; h: number }): { swap: boolean; scale: number } {
  const flat = Math.min((boxW - PAD * 2) / map.w, (boxH - PAD * 2) / map.h);
  const tall = Math.min((boxW - PAD * 2) / map.h, (boxH - PAD * 2) / map.w);
  return tall > flat * 1.08 ? { swap: true, scale: tall } : { swap: false, scale: flat };
}

/**
 * Draws the battle on a canvas: ground and roads (painted once per map and size, into an
 * offscreen layer), then orders being aimed, units on the move, and the bases on top.
 */
export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  private layer = document.createElement("canvas");
  private layerKey = "";
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private swap = false;
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private flashes: { b: number; color: string; at: number }[] = [];

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  resize(cssW: number, cssH: number): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = Math.max(1, Math.floor(cssW));
    this.cssH = Math.max(1, Math.floor(cssH));
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
    this.layerKey = "";
  }

  /** A ring that grows out of a base that just changed hands. */
  flash(b: number, color: string): void {
    this.flashes.push({ b, color, at: performance.now() });
  }

  /** The base at a point on the canvas (CSS px), or -1. */
  pick(battle: Battle, sx: number, sy: number): number {
    let best = -1;
    let bestD = Infinity;
    battle.bases.forEach((base, b) => {
      const [x, y] = this.toScreen(battle.map, b);
      const d = Math.hypot(x - sx, y - sy);
      if (d <= this.radius(base.level) + PICK_SLOP && d < bestD) {
        bestD = d;
        best = b;
      }
    });
    return best;
  }

  draw(scene: Scene, now: number): void {
    const { ctx } = this;
    const { battle } = scene;
    this.fit(battle.map);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.drawImage(this.layer, 0, 0, this.cssW, this.cssH);
    this.drawOrders(scene);
    for (const g of battle.groups) this.drawGroup(scene, g, now);
    battle.bases.forEach((_, b) => this.drawBase(scene, b));
    this.drawFlashes(battle.map, now);
  }

  // ---------------------------------------------------------------- layout

  private fit(map: GameMap): void {
    const key = `${map.id}:${map.w}x${map.h}:${this.cssW}x${this.cssH}:${map.roads.length}`;
    if (key === this.layerKey) return;
    this.layerKey = key;
    const { swap, scale } = fitMap(this.cssW, this.cssH, map);
    this.swap = swap;
    this.scale = scale;
    const w = (swap ? map.h : map.w) * scale;
    const h = (swap ? map.w : map.h) * scale;
    this.ox = (this.cssW - w) / 2;
    this.oy = (this.cssH - h) / 2;
    this.paintLayer(map);
  }

  private toScreen(map: GameMap, b: number): [number, number] {
    return this.point(map.x[b], map.y[b]);
  }

  private point(x: number, y: number): [number, number] {
    return this.swap ? [this.ox + y * this.scale, this.oy + x * this.scale] : [this.ox + x * this.scale, this.oy + y * this.scale];
  }

  private radius(level: number): number {
    return Math.max(MIN_RADIUS + (level - 1) * 2, RADIUS[level] * this.scale);
  }

  /** Ground, a faint grid and the roads: they never change during a round. */
  private paintLayer(map: GameMap): void {
    const c = this.layer;
    c.width = Math.round(this.cssW * this.dpr);
    c.height = Math.round(this.cssH * this.dpr);
    const g = c.getContext("2d")!;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = GROUND;
    g.fillRect(0, 0, this.cssW, this.cssH);
    g.strokeStyle = GRID;
    g.lineWidth = 1;
    const step = Math.max(24, 100 * this.scale);
    g.beginPath();
    for (let x = this.ox % step; x < this.cssW; x += step) g.moveTo(Math.round(x) + 0.5, 0), g.lineTo(Math.round(x) + 0.5, this.cssH);
    for (let y = this.oy % step; y < this.cssH; y += step) g.moveTo(0, Math.round(y) + 0.5), g.lineTo(this.cssW, Math.round(y) + 0.5);
    g.stroke();

    const width = Math.max(5, 10 * this.scale);
    g.lineCap = "round";
    const pass = (style: string, w: number, dash: number[] = []) => {
      g.strokeStyle = style;
      g.lineWidth = w;
      g.setLineDash(dash);
      g.beginPath();
      for (const [a, b] of map.roads) {
        g.moveTo(...this.toScreen(map, a));
        g.lineTo(...this.toScreen(map, b));
      }
      g.stroke();
    };
    pass(ROAD_EDGE, width + 3);
    pass(ROAD, width);
    pass(ROAD_LINE, 1.2, [5, 7]);
    g.setLineDash([]);
  }

  // ---------------------------------------------------------------- pieces

  private colorOf(scene: Scene, owner: number): string {
    return owner >= 0 ? (scene.looks[owner]?.color ?? NEUTRAL) : NEUTRAL;
  }

  /** Where the selection would go: road routes for tanks, straight lines for helicopters. */
  private drawOrders(scene: Scene): void {
    const { ctx } = this;
    const { battle, selected, hover, aim } = scene;
    if (!selected.length || scene.me < 0) return;
    const map = battle.map;
    const mine = this.colorOf(scene, scene.me);
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Hovering over the selection itself isn't aiming at anything (except while dragging across it).
    let target = hover >= 0 && !(aim === null && selected.includes(hover)) ? hover : -1;
    if (selected.every((s) => s === target)) target = -1;
    if (target < 0) {
      if (aim) {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 6]);
        for (const s of selected) {
          ctx.beginPath();
          ctx.moveTo(...this.toScreen(map, s));
          ctx.lineTo(aim.x, aim.y);
          ctx.stroke();
        }
      }
      ctx.restore();
      return;
    }
    let tanks = 0;
    let helis = 0;
    for (const s of selected) {
      if (s === target) continue;
      const base = battle.bases[s];
      const route = base.t > 0 ? battle.route(scene.me, s, target) : null;
      if (route) tanks += Battle.portion(base.t, scene.pct);
      helis += Battle.portion(base.h, scene.pct);
      if (route) {
        ctx.strokeStyle = mine;
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = 3;
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        route.path.forEach((b, i) => (i ? ctx.lineTo(...this.toScreen(map, b)) : ctx.moveTo(...this.toScreen(map, b))));
        ctx.stroke();
      }
      if (base.h > 0) {
        ctx.strokeStyle = HELI_INK;
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = 2;
        ctx.setLineDash([2, 6]);
        ctx.beginPath();
        ctx.moveTo(...this.toScreen(map, s));
        ctx.lineTo(...this.toScreen(map, target));
        ctx.stroke();
      }
      if (!route && !base.h) {
        // Nothing here can get there: say so where it starts.
        const [x, y] = this.toScreen(map, s);
        const r = this.radius(base.level) + 7;
        ctx.globalAlpha = 0.9;
        ctx.setLineDash([]);
        ctx.strokeStyle = "#ff5a4d";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(x + r * 0.7 - 5, y - r * 0.7 - 5);
        ctx.lineTo(x + r * 0.7 + 5, y - r * 0.7 + 5);
        ctx.moveTo(x + r * 0.7 + 5, y - r * 0.7 - 5);
        ctx.lineTo(x + r * 0.7 - 5, y - r * 0.7 + 5);
        ctx.stroke();
      }
    }
    ctx.restore();
    // What would go, over the target, and whether it's enough against what's there now
    // (helicopters get there first).
    const parts = [tanks ? `${tanks} tanks` : "", helis ? `✈${helis}` : ""].filter(Boolean);
    const [tx, ty] = this.toScreen(map, target);
    const top = ty - this.radius(battle.bases[target].level) - 22;
    if (!parts.length) {
      label(ctx, "no road there", tx, top, 12, "#ff8a80");
      return;
    }
    const tb = battle.bases[target];
    let verdict = "";
    if (tb.owner !== scene.me) {
      const air = clash(tb.t, tb.h, HELI, helis);
      const enough = air.left > 0 || (tanks > 0 && clash(air.t, air.h, TANK, tanks).left > 0);
      verdict = enough ? " · enough" : " · too few";
    }
    label(ctx, `→ ${parts.join(" ")}${verdict}`, tx, top, 12, verdict === " · too few" ? "#ffb26b" : "#fff");
  }

  private groupAt(map: GameMap, g: Group, t: number): { x: number; y: number; dx: number; dy: number } {
    const a = g.path[g.leg - 1];
    const b = g.path[g.leg];
    const t0 = g.at[g.leg - 1];
    const t1 = g.at[g.leg];
    const f = Math.max(0, Math.min(1, (t - t0) / Math.max(1, t1 - t0)));
    const [ax, ay] = this.toScreen(map, a);
    const [bx, by] = this.toScreen(map, b);
    return { x: ax + (bx - ax) * f, y: ay + (by - ay) * f, dx: bx - ax, dy: by - ay };
  }

  private drawGroup(scene: Scene, g: Group, now: number): void {
    const { ctx } = this;
    const color = this.colorOf(scene, g.owner);
    const { x, y, dx, dy } = this.groupAt(scene.battle.map, g, scene.t);
    const size = 5 + Math.min(5, Math.sqrt(g.n));
    ctx.save();
    if (g.kind === TANK) {
      ctx.translate(x, y);
      ctx.rotate(Math.atan2(dy, dx));
      ctx.fillStyle = color;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
      ctx.lineWidth = 1.5;
      roundRect(ctx, -size, -size * 0.65, size * 2, size * 1.3, 2.5);
      ctx.fill();
      ctx.stroke();
      // The turret and gun, pointing the way it's going.
      ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
      ctx.beginPath();
      ctx.arc(-size * 0.15, 0, size * 0.42, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(0, -1, size * 1.15, 2);
    } else {
      // A shadow on the ground, then the helicopter above it with its rotor turning.
      ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
      ctx.beginPath();
      ctx.ellipse(x + 4, y + 7, size * 0.8, size * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.translate(x, y);
      ctx.fillStyle = color;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.62, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const spin = (now / 60) % (Math.PI * 2);
      ctx.strokeStyle = "rgba(240, 248, 255, 0.85)";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (const a of [spin, spin + Math.PI / 2]) {
        ctx.moveTo(Math.cos(a) * size * 1.35, Math.sin(a) * size * 1.35);
        ctx.lineTo(-Math.cos(a) * size * 1.35, -Math.sin(a) * size * 1.35);
      }
      ctx.stroke();
    }
    ctx.restore();
    if (g.n > 1) label(ctx, String(g.n), x, y - size - 8, 11, "#fff");
  }

  private drawBase(scene: Scene, b: number): void {
    const { ctx } = this;
    const { battle } = scene;
    const map = battle.map;
    const base = battle.bases[b];
    const [x, y] = this.toScreen(map, b);
    const r = this.radius(base.level);
    const color = this.colorOf(scene, base.owner);
    const air = map.kind[b] === HELI;
    const selected = scene.selected.includes(b);

    ctx.save();
    if (selected || scene.hover === b) {
      ctx.strokeStyle = selected ? "#ffffff" : "rgba(255, 255, 255, 0.55)";
      ctx.lineWidth = selected ? 3 : 2;
      ctx.shadowColor = selected ? color : "transparent";
      ctx.shadowBlur = selected ? 14 : 0;
      shape(ctx, air, x, y, r + 7);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Production: an arc that fills up to the next unit, or a full ring when the base is at its cap.
    if (base.owner >= 0) {
      const full = base.t + base.h >= CAP[base.level];
      ctx.strokeStyle = color;
      ctx.globalAlpha = full ? 0.75 : 0.5;
      ctx.lineWidth = 2;
      ctx.beginPath();
      const end = full ? Math.PI * 2 : (base.prog / 1000) * Math.PI * 2;
      ctx.arc(x, y, r + 3.5, -Math.PI / 2, -Math.PI / 2 + end);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = base.owner >= 0 ? shade(color, 0.42) : NEUTRAL_FILL;
    ctx.strokeStyle = color;
    ctx.lineWidth = base.owner === scene.me && scene.me >= 0 ? 3.5 : 2.5;
    shape(ctx, air, x, y, r);
    ctx.fill();
    ctx.stroke();

    // Airfields get a helipad H behind the number.
    if (air) {
      ctx.strokeStyle = base.owner >= 0 ? shade(color, 0.7) : "#454b3f";
      ctx.lineWidth = Math.max(2, r * 0.12);
      const s = r * 0.42;
      ctx.beginPath();
      ctx.moveTo(x - s, y - s);
      ctx.lineTo(x - s, y + s);
      ctx.moveTo(x + s, y - s);
      ctx.lineTo(x + s, y + s);
      ctx.moveTo(x - s, y);
      ctx.lineTo(x + s, y);
      ctx.stroke();
    }

    // Level: one pip per level along the top.
    ctx.fillStyle = base.owner >= 0 ? color : NEUTRAL;
    for (let i = 0; i < base.level; i++) {
      const px = x + (i - (base.level - 1) / 2) * 7;
      ctx.beginPath();
      ctx.arc(px, y - r - (air ? 9 : 8), 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Every unit in the middle (blue when they're all helicopters); a mixed garrison's helicopters in a badge.
    const total = base.t + base.h;
    label(ctx, String(total), x, y + 1, Math.max(11, Math.min(17, r * 0.72)), base.h && !base.t ? HELI_INK : "#fff");
    if (base.h > 0 && base.t > 0) {
      const text = `✈${base.h}`;
      ctx.font = `600 10px ${FONT}`;
      const w = ctx.measureText(text).width + 8;
      const bx = x + r * 0.6;
      const by = y + r * 0.8;
      ctx.fillStyle = "rgba(10, 13, 8, 0.88)";
      roundRect(ctx, bx - w / 2, by - 7, w, 14, 7);
      ctx.fill();
      label(ctx, text, bx, by, 10, HELI_INK);
    }
  }

  private drawFlashes(map: GameMap, now: number): void {
    const { ctx } = this;
    this.flashes = this.flashes.filter((f) => now - f.at < 650);
    for (const f of this.flashes) {
      const k = (now - f.at) / 650;
      const [x, y] = this.toScreen(map, f.b);
      ctx.strokeStyle = f.color;
      ctx.globalAlpha = 1 - k;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, 16 + k * 34, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

/** Depots are round; airfields are diamonds. */
function shape(ctx: CanvasRenderingContext2D, air: boolean, x: number, y: number, r: number): void {
  ctx.beginPath();
  if (!air) {
    ctx.arc(x, y, r, 0, Math.PI * 2);
    return;
  }
  const s = r * 1.18;
  ctx.moveTo(x, y - s);
  ctx.lineTo(x + s, y);
  ctx.lineTo(x, y + s);
  ctx.lineTo(x - s, y);
  ctx.closePath();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string): void {
  ctx.font = `600 ${Math.round(size)}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/** A colour darkened toward black by `k` (0 = unchanged, 1 = black). */
function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(v * (1 - k));
  return `rgb(${f(n >> 16)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}
