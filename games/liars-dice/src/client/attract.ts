import { drawDie } from "./dice";

const W = 384;
const H = 216;
const FLOOR = H - 22;

interface Die {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  face: number;
  size: number;
  /** When it came to rest (ms), or 0 while it's still moving. */
  restAt: number;
}

/** Dice tumbling onto a table behind the home screen, drawn small and scaled up pixelated. */
export class Attract {
  private ctx: CanvasRenderingContext2D;
  private dice: Die[] = [];
  private last = 0;
  private nextAt = 0;

  constructor(canvas: HTMLCanvasElement) {
    canvas.width = W;
    canvas.height = H;
    this.ctx = canvas.getContext("2d")!;
  }

  frame(now: number): void {
    const dt = Math.min(50, now - (this.last || now)) / 16.67;
    this.last = now;
    if (now > this.nextAt) {
      this.nextAt = now + 260 + Math.random() * 500;
      if (this.dice.length < 26) this.dice.push(this.spawn());
    }
    for (const d of this.dice) this.step(d, dt, now);
    this.dice = this.dice.filter((d) => !d.restAt || now - d.restAt < 6000);
    this.draw(now);
  }

  private spawn(): Die {
    const fromLeft = Math.random() < 0.5;
    return {
      x: fromLeft ? -10 : W + 10,
      y: 30 + Math.random() * 70,
      vx: (fromLeft ? 1 : -1) * (1.6 + Math.random() * 2.4),
      vy: -1 - Math.random() * 1.5,
      angle: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.4,
      face: 1 + Math.floor(Math.random() * 6),
      size: 11 + Math.round(Math.random() * 5),
      restAt: 0,
    };
  }

  private step(d: Die, dt: number, now: number): void {
    if (d.restAt) return;
    d.vy += 0.12 * dt;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.angle += d.spin * dt;
    if (d.x < 6 || d.x > W - 6) {
      d.vx = -d.vx * 0.6;
      d.x = Math.min(W - 6, Math.max(6, d.x));
    }
    const floor = FLOOR - d.size / 2;
    if (d.y > floor) {
      d.y = floor;
      d.vy = -d.vy * 0.45;
      d.vx *= 0.7;
      d.spin *= 0.5;
      // Each bounce can land on a new face.
      if (Math.abs(d.vy) > 0.6) d.face = 1 + Math.floor(Math.random() * 6);
      if (Math.abs(d.vy) < 0.5 && Math.abs(d.vx) < 0.3) {
        d.vy = d.vx = d.spin = 0;
        // Settle square to the table.
        d.angle = Math.round(d.angle / (Math.PI / 2)) * (Math.PI / 2);
        d.restAt = now;
      }
    }
  }

  private draw(now: number): void {
    const c = this.ctx;
    c.fillStyle = "#0b0d17";
    c.fillRect(0, 0, W, H);
    // The table: a dark blue felt edge.
    c.fillStyle = "#121c3d";
    c.fillRect(0, FLOOR, W, H - FLOOR);
    c.fillStyle = "#1d2c5c";
    c.fillRect(0, FLOOR, W, 2);
    for (const d of this.dice) {
      const fade = d.restAt ? Math.max(0, 1 - Math.max(0, now - d.restAt - 4500) / 1500) : 1;
      drawDie(c, Math.round(d.x), Math.round(d.y), d.size, d.angle, d.face, 0.55 * fade);
    }
  }
}
