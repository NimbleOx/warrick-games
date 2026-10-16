import type { ArenaEvent, ArenaSnap, CurseKind, ItemKind } from "../shared/arena";
import { CHAR_ITEM } from "../shared/arena";
import { FALL_SHOW_MS, FUSE_MS } from "../shared/constants";
import type { Dir } from "../shared/movement";
import { mulberry32 } from "@warrick/kit/shared/rng";
import { THEMES, hexA, hexToRgb, mix, shade, type RGB, type Theme } from "./themes";

/** World units per tile. Pixel art is drawn at half this (16 art pixels per tile). */
export const TILE = 32;
const ART = 16;

export interface BomberView {
  id: string;
  x: number;
  y: number;
  face: Dir;
  alive: boolean;
  color: string;
  name: string;
  you: boolean;
  curse: CurseKind | null;
}

export interface BombView {
  id: number | string;
  x: number;
  y: number;
  at: number;
  owner: string;
}

export interface ArenaView {
  snap: ArenaSnap;
  /** Arena time to draw at (fuses, flames, falling blocks). */
  time: number;
  bombers: BomberView[];
  bombs: BombView[];
  labels: boolean;
  /** Bomber doing a victory dance. */
  cheer?: string | null;
  colorOf(id: string): string;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: number;
  size: number;
  color: string;
  born: number;
  life: number;
}

interface Floater {
  x: number;
  y: number;
  text: string;
  color: string;
  born: number;
}

interface Corpse {
  x: number;
  y: number;
  color: string;
  face: Dir;
  born: number;
}

interface Gait {
  x: number;
  y: number;
  phase: number;
  movingUntil: number;
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const FIRE = ["#fffbe0", "#ffe45c", "#ffb13b", "#ff7424", "#e8381c", "#a3150f"];
const INK = "#0b0d17";
const CORPSE_MS = 1000;

const ITEM_STYLE: Record<ItemKind, { bg: string; label: string; color: string }> = {
  bomb: { bg: "#2f6fd6", label: "+1 BOMB", color: "#8fc1ff" },
  fire: { bg: "#e0442a", label: "+1 FIRE", color: "#ffb13b" },
  speed: { bg: "#27a347", label: "SPEED UP", color: "#7cf08e" },
  kick: { bg: "#8a4fd6", label: "KICK", color: "#d3a8ff" },
  maxfire: { bg: "#e8a417", label: "MAX FIRE", color: "#ffe45c" },
  skull: { bg: "#3b3348", label: "CURSED!", color: "#c58bff" },
};

export const CURSE_LABEL: Record<CurseKind, string> = {
  slow: "Slowpoke",
  fast: "Zoomies",
  reverse: "Backwards",
  nobomb: "No bombs",
  autobomb: "Leaky bombs",
  shortfuse: "Short fuse",
  weak: "Weak fire",
};

/** Draws an arena onto a canvas. Tiles are TILE world units; positions are tile coordinates. */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cols = 15;
  private rows = 13;
  private floor = document.createElement("canvas");
  /** What the floor image was painted for: theme and size, and the grid it shows. */
  private floorKey = "";
  private floorGrid = "";
  private floorImg: ImageData | null = null;
  /** 1 for each tile painted as a wall. */
  private floorWalls = new Uint8Array(0);
  private floorSpecks = new Uint8Array(0);
  /** Per theme: a wall tile's pixels, inside and on the border. */
  private wallTiles = new Map<number, [Uint8ClampedArray, Uint8ClampedArray]>();
  private crateSprites = new Map<number, HTMLCanvasElement>();
  private gaits = new Map<string, Gait>();
  private particles: Particle[] = [];
  private floaters: Floater[] = [];
  private corpses = new Map<string, Corpse>();
  private crateBurns: { c: number; born: number }[] = [];
  private shake = 0;
  private flash = 0;
  /** World units per CSS pixel, so labels stay readable at any size. */
  private ui = 1;
  private cssWidth = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
  }

  get aspect(): number {
    return this.cols / this.rows;
  }

  resize(cssWidth: number, cols = this.cols, rows = this.rows): void {
    this.cols = cols;
    this.rows = rows;
    this.cssWidth = cssWidth;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(200, Math.round(cssWidth * dpr));
    const h = Math.round((w * rows) / cols);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ui = Math.min(2.4, Math.max(0.55, (cols * TILE) / Math.max(1, cssWidth)));
  }

  /** A new round: forget everything from the last one. */
  reset(): void {
    this.gaits.clear();
    this.particles = [];
    this.floaters = [];
    this.corpses.clear();
    this.crateBurns = [];
    this.shake = 0;
    this.flash = 0;
  }

  /** Visual reactions to arena events. `posOf` finds where a bomber is drawn right now. */
  onEvent(
    ev: ArenaEvent,
    snap: ArenaSnap,
    now: number,
    posOf: (id: string) => { x: number; y: number; color: string; face: Dir } | null,
  ): void {
    const center = (c: number) => ({ x: (c % snap.cols) * TILE + TILE / 2, y: Math.floor(c / snap.cols) * TILE + TILE / 2 });
    switch (ev.e) {
      case "boom": {
        this.shake = Math.min(10, Math.max(this.shake, 2 + ev.n * 0.35));
        if (ev.n >= 12) this.flash = Math.max(this.flash, 0.18);
        break;
      }
      case "crate": {
        this.crateBurns.push({ c: ev.c, born: now });
        const { x, y } = center(ev.c);
        const theme = THEMES[snap.theme % THEMES.length];
        for (let i = 0; i < 9; i++) {
          const a = Math.random() * Math.PI * 2;
          const v = 40 + Math.random() * 90;
          this.particles.push({
            x: x + (Math.random() - 0.5) * 16,
            y: y + (Math.random() - 0.5) * 16,
            vx: Math.cos(a) * v,
            vy: Math.sin(a) * v - 80,
            g: 420,
            size: 2 + Math.random() * 3,
            color: [theme.crate.base, theme.crate.light, theme.crate.dark][i % 3],
            born: now,
            life: 500 + Math.random() * 300,
          });
        }
        break;
      }
      case "burn": {
        const { x, y } = center(ev.c);
        this.puff(x, y, now, "#9a9aa8", 7);
        break;
      }
      case "pick": {
        const p = posOf(ev.id);
        const { x, y } = p ? { x: p.x * TILE + TILE / 2, y: p.y * TILE + TILE / 2 } : center(ev.c);
        const style = ITEM_STYLE[ev.k];
        this.floaters.push({ x, y: y - 30, text: style.label, color: style.color, born: now });
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          this.particles.push({ x, y, vx: Math.cos(a) * 70, vy: Math.sin(a) * 70, g: 0, size: 2, color: style.color, born: now, life: 380 });
        }
        break;
      }
      case "pass": {
        const p = posOf(ev.id);
        if (p) this.floaters.push({ x: p.x * TILE + TILE / 2, y: p.y * TILE - 14, text: "CAUGHT IT!", color: "#c58bff", born: now });
        break;
      }
      case "kick": {
        const { x, y } = center(ev.c);
        this.puff(x, y + 8, now, "#d8d2c0", 5);
        break;
      }
      case "die": {
        const p = posOf(ev.id);
        if (!p) break;
        this.corpses.set(ev.id, { x: p.x, y: p.y, color: p.color, face: p.face, born: now });
        this.floaters.push({ x: p.x * TILE + TILE / 2, y: p.y * TILE - 16, text: ev.by ? "K.O.!" : "SQUASH", color: "#ff6b6b", born: now });
        break;
      }
      case "drop": {
        const { x, y } = center(ev.c);
        this.shake = Math.max(this.shake, 2.5);
        this.puff(x, y + 10, now, "#cfc6b8", 6);
        break;
      }
    }
  }

  private puff(x: number, y: number, now: number, color: string, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 20 + Math.random() * 40;
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 20, g: -20, size: 3 + Math.random() * 3, color, born: now, life: 450 });
    }
  }

  // ---------------------------------------------------------------- frame

  draw(view: ArenaView, now: number): void {
    const { snap } = view;
    if (snap.cols !== this.cols || snap.rows !== this.rows) this.resize(this.cssWidth || this.canvas.clientWidth, snap.cols, snap.rows);
    const ctx = this.ctx;
    const theme = THEMES[snap.theme % THEMES.length];
    const W = snap.cols * TILE;
    const H = snap.rows * TILE;
    const k = this.canvas.width / W;

    this.syncFloor(snap, theme);

    let ox = 0;
    let oy = 0;
    if (this.shake > 0.3) {
      ox = (Math.random() - 0.5) * this.shake;
      oy = (Math.random() - 0.5) * this.shake;
      this.shake *= 0.85;
    } else {
      this.shake = 0;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(k, 0, 0, k, ox * k, oy * k);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.floor, 0, 0, W, H);

    const crate = this.crateSprite(snap.theme, theme);
    const t = view.time;
    // Shadows under crates, then items and crates.
    ctx.fillStyle = "rgba(0, 0, 0, 0.22)";
    for (let c = 0; c < snap.grid.length; c++) {
      if (snap.grid[c] !== "+") continue;
      const below = c + snap.cols;
      if (below < snap.grid.length && snap.grid[below] !== "#" && snap.grid[below] !== "+") {
        ctx.fillRect((c % snap.cols) * TILE, Math.floor(below / snap.cols) * TILE, TILE, 7);
      }
    }
    for (let c = 0; c < snap.grid.length; c++) {
      const ch = snap.grid[c];
      const x = (c % snap.cols) * TILE;
      const y = Math.floor(c / snap.cols) * TILE;
      if (ch === "+") ctx.drawImage(crate, x, y, TILE, TILE);
      else if (CHAR_ITEM[ch]) this.drawItem(CHAR_ITEM[ch], x, y, now);
    }
    this.crateBurns = this.crateBurns.filter((b) => now - b.born < 420);
    for (const b of this.crateBurns) {
      const f = (now - b.born) / 420;
      const x = (b.c % snap.cols) * TILE;
      const y = Math.floor(b.c / snap.cols) * TILE;
      const s = 1 - f * 0.6;
      ctx.globalAlpha = 1 - f;
      ctx.drawImage(crate, x + (TILE * (1 - s)) / 2, y + (TILE * (1 - s)) / 2, TILE * s, TILE * s);
      ctx.fillStyle = `rgba(20, 8, 4, ${0.5 * f + 0.2})`;
      ctx.fillRect(x + (TILE * (1 - s)) / 2, y + (TILE * (1 - s)) / 2, TILE * s, TILE * s);
      ctx.globalAlpha = 1;
    }

    // Only join up with neighbors that are still burning: overlapping blasts can leave stale sides.
    const burning = new Set(snap.flames.map((f) => f.c));
    const sides = [-snap.cols, 1, snap.cols, -1];
    for (const f of snap.flames) {
      let mask = 0;
      for (let i = 0; i < 4; i++) if (f.m & (1 << i) && burning.has(f.c + sides[i])) mask |= 1 << i;
      this.drawFlame(snap, f.c, mask, f.b, f.u, t);
    }
    for (const b of view.bombs) this.drawBomb(b, t, now, view.colorOf(b.owner));

    // Bombers, back to front, so the one in front overlaps the one behind.
    const bombers = view.bombers.filter((b) => b.alive).sort((a, b) => a.y - b.y);
    for (const b of bombers) {
      const gait = this.gait(b, now);
      this.drawBomber(b.x, b.y, b.color, b.face, gait.phase, now < gait.movingUntil, now, {
        curse: b.curse,
        cheer: view.cheer === b.id,
      });
    }
    for (const [id, c] of this.corpses) {
      if (now - c.born > CORPSE_MS) this.corpses.delete(id);
      else this.drawCorpse(c, now);
    }

    for (const [c, at] of snap.falls) this.drawFallingBlock(snap, theme, c, at, t);

    this.drawParticles(now);
    if (view.labels) for (const b of bombers) this.drawLabel(b, now);
    this.drawFloaters(now);

    if (snap.hurryAt !== null && t >= snap.hurryAt) {
      const pulse = 0.25 + 0.2 * Math.sin(now / 160);
      ctx.strokeStyle = `rgba(255, 60, 60, ${pulse})`;
      ctx.lineWidth = 6;
      ctx.strokeRect(3, 3, W - 6, H - 6);
    }
    if (this.flash > 0.01) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = `rgba(255, 245, 220, ${this.flash})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.flash *= 0.82;
    }
  }

  private gait(b: BomberView, now: number): Gait {
    let g = this.gaits.get(b.id);
    if (!g) {
      g = { x: b.x, y: b.y, phase: 0, movingUntil: 0 };
      this.gaits.set(b.id, g);
    }
    const d = Math.abs(b.x - g.x) + Math.abs(b.y - g.y);
    if (d > 0.0005 && d < 2) {
      g.phase += d * 2.4;
      g.movingUntil = now + 90;
    }
    g.x = b.x;
    g.y = b.y;
    return g;
  }

  // ---------------------------------------------------------------- tiles

  /**
   * Keep the floor image (floor and walls) in step with the grid. A new arena paints all of it;
   * after that only tiles whose wall came or went are painted again, with the two neighbors
   * whose shading they set. Sudden death drops a wall several times a second.
   */
  private syncFloor(snap: ArenaSnap, theme: Theme): void {
    const { cols, rows, grid } = snap;
    const key = `${snap.theme}:${cols}x${rows}`;
    if (key !== this.floorKey || !this.floorImg) {
      const w = cols * ART;
      const h = rows * ART;
      this.floor.width = w;
      this.floor.height = h;
      this.floorImg = new ImageData(w, h);
      const rng = mulberry32(snap.theme * 7919 + cols * 31 + rows);
      this.floorSpecks = new Uint8Array(w * h);
      for (let i = 0; i < this.floorSpecks.length; i++) this.floorSpecks[i] = rng() < 0.07 ? 1 : 0;
      this.floorWalls = new Uint8Array(cols * rows);
      for (let c = 0; c < this.floorWalls.length; c++) this.floorWalls[c] = grid[c] === "#" ? 1 : 0;
      for (let c = 0; c < this.floorWalls.length; c++) this.paintTile(c, cols, rows, theme, snap.theme);
      this.floor.getContext("2d")!.putImageData(this.floorImg, 0, 0);
      this.floorKey = key;
      this.floorGrid = grid;
      return;
    }
    if (grid === this.floorGrid) return;
    this.floorGrid = grid;
    const walls = this.floorWalls;
    const dirty = new Set<number>();
    for (let c = 0; c < walls.length; c++) {
      const wall = grid[c] === "#" ? 1 : 0;
      if (wall === walls[c]) continue;
      walls[c] = wall;
      dirty.add(c);
      if ((c % cols) + 1 < cols) dirty.add(c + 1);
      if (c + cols < walls.length) dirty.add(c + cols);
    }
    const g = this.floor.getContext("2d")!;
    for (const c of dirty) {
      this.paintTile(c, cols, rows, theme, snap.theme);
      g.putImageData(this.floorImg, 0, 0, (c % cols) * ART, Math.floor(c / cols) * ART, ART, ART);
    }
  }

  /** Paint one tile of the floor image, from `floorWalls`. Plain numbers throughout: it runs for every pixel. */
  private paintTile(c: number, cols: number, rows: number, theme: Theme, themeIndex: number): void {
    const d = this.floorImg!.data;
    const walls = this.floorWalls;
    const w = cols * ART;
    const tx = c % cols;
    const ty = (c - tx) / cols;
    const isWall = (x: number, y: number) => x < 0 || y < 0 || x >= cols || y >= rows || walls[y * cols + x] === 1;
    if (walls[c]) {
      const border = tx === 0 || ty === 0 || tx === cols - 1 || ty === rows - 1;
      const tile = this.wallTile(themeIndex, theme)[border ? 1 : 0];
      for (let py = 0; py < ART; py++) d.set(tile.subarray(py * ART * 4, (py + 1) * ART * 4), ((ty * ART + py) * w + tx * ART) * 4);
      return;
    }
    const base = hexToRgb(theme.floor[(tx + ty) % 2 ? 0 : 1]);
    const speck = hexToRgb(theme.speck);
    const seam = hexToRgb(theme.seam);
    const shadeTop = isWall(tx, ty - 1);
    const shadeLeft = isWall(tx - 1, ty);
    for (let py = 0; py < ART; py++) {
      for (let px = 0; px < ART; px++) {
        const X = tx * ART + px;
        const Y = ty * ART + py;
        const dither = BAYER[(py & 3) * 4 + (px & 3)] / 16;
        const from = this.floorSpecks[Y * w + X] && py > 1 && px > 0 ? speck : base;
        let r = from[0];
        let gr = from[1];
        let b = from[2];
        // The same sums as mix(), towards the seam color and then towards black.
        if (px === ART - 1 || py === ART - 1) {
          r += (seam[0] - r) * 0.6;
          gr += (seam[1] - gr) * 0.6;
          b += (seam[2] - b) * 0.6;
        }
        if (shadeTop && py < 5) {
          const k = py < 3 ? 0.38 : dither < 0.5 ? 0.38 : 0.1;
          r += (0 - r) * k;
          gr += (0 - gr) * k;
          b += (0 - b) * k;
        }
        if (shadeLeft && px < 3) {
          const k = px < 2 ? 0.2 : dither < 0.5 ? 0.2 : 0.05;
          r += (0 - r) * k;
          gr += (0 - gr) * k;
          b += (0 - b) * k;
        }
        const i = (Y * w + X) * 4;
        d[i] = r;
        d[i + 1] = gr;
        d[i + 2] = b;
        d[i + 3] = 255;
      }
    }
  }

  private wallTile(index: number, theme: Theme): [Uint8ClampedArray, Uint8ClampedArray] {
    const cached = this.wallTiles.get(index);
    if (cached) return cached;
    const wall = {
      top: hexToRgb(theme.wall.top),
      face: hexToRgb(theme.wall.face),
      light: hexToRgb(theme.wall.light),
      dark: hexToRgb(theme.wall.dark),
    };
    const black: RGB = [0, 0, 0];
    const tiles: [Uint8ClampedArray, Uint8ClampedArray] = [new Uint8ClampedArray(ART * ART * 4), new Uint8ClampedArray(ART * ART * 4)];
    for (let py = 0; py < ART; py++) {
      for (let px = 0; px < ART; px++) {
        const c = wallPixel(wall, px, py, BAYER[(py & 3) * 4 + (px & 3)] / 16);
        tiles.forEach((tile, border) => {
          const v = border ? mix(c, black, 0.18) : c;
          tile.set([v[0], v[1], v[2], 255], (py * ART + px) * 4);
        });
      }
    }
    this.wallTiles.set(index, tiles);
    return tiles;
  }

  private crateSprite(index: number, theme: Theme): HTMLCanvasElement {
    const cached = this.crateSprites.get(index);
    if (cached) return cached;
    const cv = document.createElement("canvas");
    cv.width = ART;
    cv.height = ART;
    const g = cv.getContext("2d")!;
    const img = g.createImageData(ART, ART);
    const base = hexToRgb(theme.crate.base);
    const light = hexToRgb(theme.crate.light);
    const dark = hexToRgb(theme.crate.dark);
    const mortar = hexToRgb(theme.crate.mortar);
    for (let py = 0; py < ART; py++) {
      for (let px = 0; px < ART; px++) {
        let c: RGB;
        if (py >= 13) {
          // Front face.
          c = py === 15 ? mortar : dark;
          if (py === 13 && (px === 5 || px === 11)) c = mortar;
        } else {
          const band = Math.floor(py / 4.34);
          const by = py - Math.round(band * 4.34);
          const joints = band % 2 === 0 ? [5, 11] : [0, 8, 15];
          if (py === 4 || py === 8 || py === 12 || joints.includes(px)) c = mortar;
          else if (by === 0) c = light;
          else if (by >= 2 && (px + 1) % 6 === 0) c = dark;
          else c = base;
          if (py === 0) c = mix(c, light, 0.6);
        }
        const i = (py * ART + px) * 4;
        img.data[i] = c[0];
        img.data[i + 1] = c[1];
        img.data[i + 2] = c[2];
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    this.crateSprites.set(index, cv);
    return cv;
  }

  private drawFallingBlock(snap: ArenaSnap, theme: Theme, c: number, at: number, t: number): void {
    const left = at - t;
    if (left > FALL_SHOW_MS || left < 0) return;
    const ctx = this.ctx;
    const f = 1 - left / FALL_SHOW_MS;
    const x = (c % snap.cols) * TILE;
    const y = Math.floor(c / snap.cols) * TILE;
    ctx.fillStyle = `rgba(0, 0, 0, ${0.15 + f * 0.35})`;
    ctx.beginPath();
    ctx.ellipse(x + TILE / 2, y + TILE / 2 + 4, 6 + f * 10, 3 + f * 5, 0, 0, Math.PI * 2);
    ctx.fill();
    const drop = (1 - f * f) * TILE * 4;
    ctx.fillStyle = theme.wall.top;
    ctx.fillRect(x + 1, y - drop + 1, TILE - 2, TILE - 9);
    ctx.fillStyle = theme.wall.face;
    ctx.fillRect(x + 1, y - drop + TILE - 8, TILE - 2, 7);
    ctx.strokeStyle = theme.wall.dark;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 1, y - drop + 1, TILE - 2, TILE - 2);
  }

  // ---------------------------------------------------------------- items

  private drawItem(k: ItemKind, x: number, y: number, now: number): void {
    const ctx = this.ctx;
    const style = ITEM_STYLE[k];
    const bob = Math.sin(now / 260 + x * 0.1) * 1;
    const px = x + 3;
    const py = y + 3 + bob;
    const s = TILE - 6;
    ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
    ctx.fillRect(x + 4, y + TILE - 5, TILE - 8, 3);
    ctx.fillStyle = shade(style.bg, -0.45);
    roundRect(ctx, px, py, s, s, 4);
    ctx.fill();
    ctx.fillStyle = style.bg;
    roundRect(ctx, px + 1.5, py + 1.5, s - 3, s - 4.5, 3);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
    roundRect(ctx, px + 3, py + 2.5, s - 6, 4, 2);
    ctx.fill();
    const cx = px + s / 2;
    const cy = py + s / 2;
    ctx.save();
    ctx.translate(cx, cy);
    drawGlyph(ctx, k);
    ctx.restore();
    // A glint sweeps across now and then.
    const glint = ((now / 1600 + x * 0.013 + y * 0.007) % 1) * 2.4 - 0.7;
    if (glint > 0 && glint < 1) {
      ctx.save();
      roundRect(ctx, px + 1.5, py + 1.5, s - 3, s - 4.5, 3);
      ctx.clip();
      ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
      ctx.beginPath();
      const gx = px + glint * (s + 10) - 5;
      ctx.moveTo(gx, py);
      ctx.lineTo(gx + 5, py);
      ctx.lineTo(gx - 5, py + s);
      ctx.lineTo(gx - 10, py + s);
      ctx.fill();
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------- bombs & fire

  private drawBomb(b: BombView, t: number, now: number, color: string): void {
    const ctx = this.ctx;
    const left = b.at - t;
    const frac = Math.max(0, Math.min(1, 1 - left / FUSE_MS));
    const pulse = 1 + 0.08 * Math.sin(now / (190 - 120 * frac));
    const cx = b.x * TILE + TILE / 2;
    const cy = b.y * TILE + TILE / 2 + 2;
    const r = 10.5 * pulse;

    ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
    ctx.beginPath();
    ctx.ellipse(cx, b.y * TILE + TILE - 4, 10, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();

    const hot = left < 650 && Math.floor(now / 90) % 2 === 0;
    const body = ctx.createRadialGradient(cx - 3, cy - 4, 1, cx, cy, r);
    body.addColorStop(0, hot ? "#ff8a7a" : "#4a5070");
    body.addColorStop(1, hot ? "#8a1010" : "#10121f");
    ctx.fillStyle = body;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Owner's color band, so you can tell whose is whose.
    ctx.strokeStyle = hexA(color, 0.9);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r - 3, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
    ctx.beginPath();
    ctx.ellipse(cx - 4, cy - 4.5, 2.6, 1.6, -0.6, 0, Math.PI * 2);
    ctx.fill();
    // Cap and fuse.
    ctx.fillStyle = "#2a2e44";
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.2;
    ctx.save();
    ctx.translate(cx + r * 0.55, cy - r * 0.75);
    ctx.rotate(0.6);
    ctx.fillRect(-3, -3, 6, 4);
    ctx.strokeRect(-3, -3, 6, 4);
    ctx.restore();
    const fx = cx + r * 0.55 + 4;
    const fy = cy - r * 0.75 - 5;
    ctx.strokeStyle = "#c9b48a";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(cx + r * 0.6, cy - r * 0.8);
    ctx.quadraticCurveTo(fx + 2, fy + 2, fx + 1, fy - 2);
    ctx.stroke();
    const spark = 2 + Math.random() * 2.5;
    ctx.fillStyle = FIRE[Math.floor(Math.random() * 3)];
    star(ctx, fx + 1, fy - 3, spark, spark * 0.4, 4 + (Math.floor(now / 60) % 2));
  }

  private drawFlame(snap: ArenaSnap, c: number, mask: number, born: number, until: number, t: number): void {
    if (t < born) return;
    const ctx = this.ctx;
    const age = t - born;
    const grow = Math.min(1, age / 70);
    const shrink = Math.max(0, Math.min(1, (until - t) / 180));
    const s = grow * shrink;
    if (s <= 0) return;
    const cx = (c % snap.cols) * TILE + TILE / 2;
    const cy = Math.floor(c / snap.cols) * TILE + TILE / 2;
    const cycle = Math.floor(age / 45);
    const layers: [number, string][] = [
      [28, FIRE[3 + (cycle % 3)]],
      [19, FIRE[1 + (cycle % 2)]],
      [9, FIRE[0]],
    ];
    for (const [width, color] of layers) {
      const w = width * s;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, w / 2, 0, Math.PI * 2);
      ctx.fill();
      const h = TILE / 2 + 0.6;
      if (mask & 1) ctx.fillRect(cx - w / 2, cy - h, w, h);
      if (mask & 2) ctx.fillRect(cx, cy - w / 2, h, w);
      if (mask & 4) ctx.fillRect(cx - w / 2, cy, w, h);
      if (mask & 8) ctx.fillRect(cx - h, cy - w / 2, h, w);
    }
  }

  // ---------------------------------------------------------------- bombers

  /** A little bomber at tile (x, y): helmet, visor, antenna ball in its color. */
  drawBomber(
    x: number,
    y: number,
    color: string,
    face: Dir,
    phase: number,
    moving: boolean,
    now: number,
    opts: { curse?: CurseKind | null; cheer?: boolean; alpha?: number; squash?: number } = {},
  ): void {
    const ctx = this.ctx;
    const cx = x * TILE + TILE / 2;
    let base = y * TILE + TILE / 2;
    const swing = moving ? Math.sin(phase * Math.PI) : 0;
    let bob = moving ? Math.abs(swing) * 1.4 : 0;
    if (opts.cheer) bob = Math.abs(Math.sin(now / 140)) * 7;
    const squash = opts.squash ?? 1;

    ctx.save();
    ctx.globalAlpha = opts.alpha ?? 1;
    ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
    ctx.beginPath();
    ctx.ellipse(cx, base + 13, 9 - bob * 0.4, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();

    if (squash !== 1) {
      ctx.translate(cx, base + 14);
      ctx.scale(1 + (1 - squash) * 0.6, squash);
      ctx.translate(-cx, -(base + 14));
    }
    base -= bob;
    const side = face === 2 || face === 4;
    const dirX = face === 2 ? 1 : face === 4 ? -1 : 0;
    const dark = shade(color, -0.45);

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = INK;
    // Feet.
    const stepA = side ? swing * 2.5 : 0;
    const liftA = side ? 0 : swing * 1.6;
    ctx.fillStyle = dark;
    for (const [fx, lift] of [
      [-4.5 + stepA, liftA],
      [4.5 - stepA, -liftA],
    ]) {
      ctx.beginPath();
      ctx.ellipse(cx + fx + dirX * 1.5, base + 11.5 + bob - Math.max(0, lift), 4.2, 2.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // Body.
    ctx.fillStyle = color;
    roundRect(ctx, cx - 7.5, base - 1, 15, 11.5, 4.5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = dark;
    ctx.fillRect(cx - 6.8, base + 5, 13.6, 2);
    ctx.fillStyle = "#ffd23f";
    ctx.fillRect(cx - 1.5, base + 4.6, 3, 2.8);
    // Hands.
    ctx.fillStyle = "#f6f4fb";
    const handUp = opts.cheer ? -9 : 0;
    for (const [hx, hy] of [
      [-9.5, 3 + swing * 1.5 + handUp],
      [9.5, 3 - swing * 1.5 + handUp],
    ]) {
      ctx.beginPath();
      ctx.arc(cx + hx, base + hy, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // Head.
    const hy = base - 9;
    ctx.fillStyle = "#f6f4fb";
    ctx.beginPath();
    ctx.arc(cx, hy, 10.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(170, 170, 200, 0.35)";
    ctx.beginPath();
    ctx.arc(cx + 2, hy + 3, 8, 0.1 * Math.PI, 0.9 * Math.PI);
    ctx.fill();
    if (face !== 1) {
      const vx = cx - 7 + dirX * 3.5;
      const vw = side ? 12 : 14;
      ctx.fillStyle = "#1b2140";
      roundRect(ctx, vx + (side && dirX < 0 ? 0 : side ? 2 : 0), hy - 4, vw, 9, 4);
      ctx.fill();
      const eyeX = cx + dirX * 4;
      ctx.fillStyle = "#ffffff";
      for (const ex of side ? [eyeX - 1.6, eyeX + 2.4 * dirX] : [cx - 3.2, cx + 3.2]) {
        ctx.beginPath();
        ctx.ellipse(ex, hy + 0.5, 1.4, 2.6, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
      ctx.beginPath();
      ctx.ellipse(cx - 3, hy - 4, 3, 2, -0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    // Antenna.
    const sway = moving ? swing * 1.6 : Math.sin(now / 400) * 0.6;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(cx, hy - 10);
    ctx.lineTo(cx + sway, hy - 15);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx + sway, hy - 17, 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    if (opts.curse) {
      // Cursed: flicker purple, with a skull bobbing overhead.
      if (Math.floor(now / 110) % 2 === 0) {
        ctx.globalAlpha = (opts.alpha ?? 1) * 0.45;
        ctx.fillStyle = "#6b2fb3";
        ctx.beginPath();
        ctx.arc(cx, hy, 11, 0, Math.PI * 2);
        ctx.fill();
        roundRect(ctx, cx - 8, base - 1, 16, 12, 4.5);
        ctx.fill();
        ctx.globalAlpha = opts.alpha ?? 1;
      }
      ctx.save();
      ctx.translate(cx + 11, hy - 16 + Math.sin(now / 200) * 1.5);
      ctx.scale(0.5, 0.5);
      drawGlyph(ctx, "skull");
      ctx.restore();
    }
    ctx.restore();
  }

  private drawCorpse(c: Corpse, now: number): void {
    const f = (now - c.born) / CORPSE_MS;
    const blink = Math.floor(now / 70) % 2 === 0;
    if (f < 0.55) {
      this.drawBomber(c.x, c.y, blink ? "#ffffff" : c.color, c.face, 0, false, now, { squash: 1 - f * 0.4 });
    } else {
      const g = (f - 0.55) / 0.45;
      this.drawBomber(c.x, c.y, c.color, c.face, 0, false, now, { squash: Math.max(0.05, 0.78 * (1 - g)), alpha: 1 - g });
    }
  }

  private drawLabel(b: BomberView, now: number): void {
    const ctx = this.ctx;
    const u = this.ui;
    const x = b.x * TILE + TILE / 2;
    const top = b.y * TILE - 16;
    const fontPx = 10.5 * u;
    ctx.font = `600 ${fontPx}px "IBM Plex Mono", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    if (b.you) {
      const bobY = Math.sin(now / 180) * 2;
      const ty = top - 4 - bobY;
      ctx.fillStyle = "#ffd23f";
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x - 5 * u, ty - 7 * u);
      ctx.lineTo(x + 5 * u, ty - 7 * u);
      ctx.lineTo(x, ty);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      return;
    }
    ctx.lineWidth = 3 * u;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
    ctx.strokeText(b.name, x, top - 2);
    ctx.fillStyle = shade(b.color, 0.4);
    ctx.fillText(b.name, x, top - 2);
  }

  private drawParticles(now: number): void {
    const ctx = this.ctx;
    this.particles = this.particles.filter((p) => now - p.born < p.life);
    for (const p of this.particles) {
      const s = (now - p.born) / 1000;
      const x = p.x + p.vx * s;
      const y = p.y + p.vy * s + 0.5 * p.g * s * s;
      ctx.globalAlpha = 1 - (now - p.born) / p.life;
      ctx.fillStyle = p.color;
      ctx.fillRect(x - p.size / 2, y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  private drawFloaters(now: number): void {
    const ctx = this.ctx;
    const u = this.ui;
    ctx.textAlign = "center";
    ctx.font = `${8 * u}px "Press Start 2P", monospace`;
    this.floaters = this.floaters.filter((f) => now - f.born < 1300);
    for (const f of this.floaters) {
      const t = (now - f.born) / 1300;
      const y = f.y - t * 22;
      ctx.globalAlpha = 1 - t * t;
      ctx.lineWidth = 3 * u;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
      ctx.strokeText(f.text, f.x, y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, y);
    }
    ctx.globalAlpha = 1;
  }
}

// ------------------------------------------------------------------ helpers

function wallPixel(w: { top: RGB; face: RGB; light: RGB; dark: RGB }, px: number, py: number, dither: number): RGB {
  // A raised block: lit top face, darker front face, outlined.
  if (py >= 12) {
    if (py === 15) return w.dark;
    if (px === 0 || px === 15) return mix(w.face, w.dark, 0.5);
    return py === 12 ? mix(w.face, w.dark, 0.35) : w.face;
  }
  if (py === 0 || px === 0) return w.light;
  if (px === 15) return mix(w.top, w.dark, 0.5);
  // Inset panel on top.
  if (px >= 3 && px <= 12 && py >= 3 && py <= 9) {
    if (py === 3 || px === 3) return mix(w.top, w.dark, 0.25);
    if (py === 9 || px === 12) return mix(w.top, w.light, 0.55);
    return mix(w.top, w.light, dither < 0.3 ? 0.18 : 0.08);
  }
  const t = (px + py) / 26;
  return mix(w.top, w.light, t < dither * 0.5 ? 0.22 : 0);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, outer: number, inner: number, points: number): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? inner : outer;
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
}

/** Power-up icons, centered on the origin, about 18 units across. */
function drawGlyph(ctx: CanvasRenderingContext2D, k: ItemKind): void {
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  switch (k) {
    case "bomb": {
      ctx.fillStyle = "#11131f";
      ctx.beginPath();
      ctx.arc(-1, 1.5, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.beginPath();
      ctx.arc(-3.5, -1, 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#f3e2b0";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(3, -3);
      ctx.quadraticCurveTo(5, -7, 7, -6);
      ctx.stroke();
      ctx.fillStyle = "#ffe45c";
      star(ctx, 7, -6.5, 2.6, 1, 4);
      break;
    }
    case "fire":
    case "maxfire": {
      const big = k === "maxfire";
      ctx.fillStyle = big ? "#e8381c" : "#ffe45c";
      flame(ctx, 0, 1, big ? 8.5 : 7.5);
      ctx.fillStyle = big ? "#ffe45c" : "#ff7424";
      flame(ctx, 0, 3, big ? 5 : 4.2);
      if (big) {
        ctx.fillStyle = "#fffbe0";
        flame(ctx, 0, 4.5, 2.4);
      }
      break;
    }
    case "speed": {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2.6;
      for (const ox of [-4, 2]) {
        ctx.beginPath();
        ctx.moveTo(ox - 2, -6);
        ctx.lineTo(ox + 4, 0);
        ctx.lineTo(ox - 2, 6);
        ctx.stroke();
      }
      break;
    }
    case "kick": {
      // A boot.
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#2a1650";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-5, -7);
      ctx.lineTo(1, -7);
      ctx.lineTo(1, 0);
      ctx.lineTo(6, 1.5);
      ctx.quadraticCurveTo(8, 3, 7, 6);
      ctx.lineTo(-5, 6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#2a1650";
      ctx.fillRect(-5, 4, 12, 2);
      break;
    }
    case "skull": {
      ctx.fillStyle = "#f3eefc";
      ctx.beginPath();
      ctx.arc(0, -1.5, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(-3.8, 3, 7.6, 4.5);
      ctx.fillStyle = "#1b1428";
      ctx.beginPath();
      ctx.arc(-2.6, -1.5, 1.8, 0, Math.PI * 2);
      ctx.arc(2.6, -1.5, 1.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(-0.6, 1.5, 1.2, 1.6);
      ctx.fillRect(-2.2, 5, 0.9, 2.5);
      ctx.fillRect(1.3, 5, 0.9, 2.5);
      break;
    }
  }
}

function flame(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - s * 1.25);
  ctx.bezierCurveTo(x + s * 0.4, y - s * 0.5, x + s, y - s * 0.2, x + s * 0.8, y + s * 0.45);
  ctx.bezierCurveTo(x + s * 0.6, y + s, x - s * 0.6, y + s, x - s * 0.8, y + s * 0.45);
  ctx.bezierCurveTo(x - s, y - s * 0.1, x - s * 0.2, y - s * 0.4, x, y - s * 1.25);
  ctx.fill();
}

