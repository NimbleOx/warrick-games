import { DEFAULT_COLORS } from "@warrick/kit/shared/constants";
import { Match } from "../shared/ai";
import { Arena } from "../shared/arena";
import { THEME_COUNT, TICK_MS } from "../shared/constants";
import { mulberry32, randInt, randomSeed, type Rng } from "@warrick/kit/shared/rng";
import { Renderer, type BomberView } from "./render";

const DEMO_BOMBERS = 6;

/** Self-playing CPU battle behind the home screen. */
export class Attract {
  private renderer: Renderer;
  private rng: Rng = mulberry32(randomSeed());
  private match!: Match;
  private colors = new Map<string, string>();
  private last = 0;
  private acc = 0;
  private resetAt = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.reset();
  }

  resize(): void {
    // The window's size, with the arena cropped to fill it: a canvas sized for the larger fit
    // and cropped by CSS would draw three times the pixels on a phone held upright.
    const a = this.match.arena;
    this.renderer.resizeCover(window.innerWidth, window.innerHeight, a.cols, a.rows);
  }

  frame(now: number): void {
    const dt = Math.min(100, this.last ? now - this.last : 0);
    this.last = now;
    const arena = this.match.arena;
    this.acc += dt;
    while (this.acc >= TICK_MS) {
      this.acc -= TICK_MS;
      // Skip the countdown; the demo is already mid-fight.
      this.match.step(arena.time < arena.goAt ? arena.goAt : TICK_MS);
    }
    const snap = arena.snapshot(true);
    const posOf = (id: string) => {
      const p = arena.player(id);
      return p ? { x: p.x, y: p.y, face: p.face, color: this.colors.get(id) ?? "#fff" } : null;
    };
    for (const ev of snap.ev) this.renderer.onEvent(ev, snap, now, posOf);
    if (arena.result && !this.resetAt) this.resetAt = now + 2500;
    if (this.resetAt && now > this.resetAt) {
      this.reset();
      return;
    }
    const bombers: BomberView[] = snap.players.map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      face: p.f,
      alive: p.alive,
      color: this.colors.get(p.id) ?? "#fff",
      name: "",
      you: false,
      curse: p.c,
    }));
    this.renderer.draw(
      {
        snap,
        time: snap.time,
        bombers,
        bombs: snap.bombs.map((b) => ({ id: b.id, x: b.x, y: b.y, at: b.at, owner: b.o })),
        labels: false,
        cheer: arena.result?.winner ?? null,
        colorOf: (id) => this.colors.get(id) ?? "#fff",
      },
      now,
    );
  }

  private reset(): void {
    const rng = this.rng;
    const ids = Array.from({ length: DEMO_BOMBERS }, (_, i) => `d${i}`);
    this.colors.clear();
    const offset = randInt(rng, 0, DEFAULT_COLORS.length - 1);
    ids.forEach((id, i) => this.colors.set(id, DEFAULT_COLORS[(offset + i) % DEFAULT_COLORS.length]));
    const arena = new Arena(rng, ids, {
      cols: 17,
      rows: 13,
      crates: 0.6,
      items: 0.5,
      skulls: true,
      hurryMs: 50_000,
      theme: randInt(rng, 0, THEME_COUNT - 1),
    });
    this.match = new Match(
      arena,
      ids.map((id, i) => ({ id, level: i % 2 ? "hard" : "normal" })),
      rng,
    );
    this.renderer.reset();
    this.resetAt = 0;
    this.acc = 0;
    if (this.last) this.resize();
  }
}
