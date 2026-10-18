import { DEFAULT_COLORS as PLAYER_COLORS } from "@warrick/kit/shared/constants";
import { THEME_COUNT, TICK_MS, TURRET_Y, WORLD_W } from "../shared/constants";
import { mulberry32, randInt, randomSeed, type Rng } from "@warrick/kit/shared/rng";
import { World, launchFor } from "../shared/sim";
import { TERRAIN_STYLES, flattenPad, generateTerrain } from "../shared/terrain";
import type { WeaponId } from "../shared/weapons";
import { Renderer, type TankInfo } from "./render";

const DEMO_WEAPONS: WeaponId[] = [
  "missile",
  "baby_nuke",
  "mirv",
  "funky_bomb",
  "leapfrog",
  "roller",
  "missile",
  "nuke",
  "napalm",
  "sandhog",
  "laser",
];

/** Self-playing demo battle behind the home screen. */
export class Attract {
  private renderer: Renderer;
  private rng: Rng = mulberry32(randomSeed());
  private world!: World;
  private theme = 0;
  private tanks = new Map<string, TankInfo>();
  private nextShotAt = 0;
  private shotStart = 0;
  private shooting = false;
  private resetAt = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.reset();
  }

  resize(): void {
    // The canvas is CSS-scaled with object-fit: cover, so size it for the larger fit.
    this.renderer.resize(Math.max(window.innerWidth, (window.innerHeight * 16) / 9));
  }

  frame(now: number): void {
    if (this.shooting) {
      const target = Math.floor((now - this.shotStart) / TICK_MS);
      let steps = 0;
      while (this.world.tick < target && !this.world.done && steps++ < 120) this.world.step();
      if (this.world.done) {
        this.shooting = false;
        this.nextShotAt = now + 900 + this.rng() * 900;
      }
    } else if (this.resetAt && now > this.resetAt) {
      this.reset();
    } else if (!this.resetAt && now > this.nextShotAt) {
      this.fire(now);
    }
    this.renderer.draw(this.world, { theme: this.theme, tanks: this.tanks, labels: false }, now);
  }

  private reset(): void {
    const rng = this.rng;
    const heights = generateTerrain(rng, TERRAIN_STYLES[randInt(rng, 0, TERRAIN_STYLES.length - 1)]);
    this.theme = randInt(rng, 0, THEME_COUNT - 1);
    this.tanks.clear();
    const n = 5;
    const tanks = [];
    for (let i = 0; i < n; i++) {
      const x = Math.round(80 + ((WORLD_W - 160) / (n - 1)) * i + (rng() - 0.5) * 60);
      const y = flattenPad(heights, x);
      const id = `d${i}`;
      tanks.push({ id, x, y, health: 100, alive: true, shield: 0, parachutes: 0 });
      this.tanks.set(id, {
        name: "",
        color: PLAYER_COLORS[(i * 3) % PLAYER_COLORS.length],
        angle: 90,
        active: false,
        you: false,
      });
    }
    this.world = new World({ heights, tanks, wind: randInt(rng, -6, 6), walls: "open" });
    this.renderer.newShot();
    this.resetAt = 0;
    this.nextShotAt = performance.now() + 600;
  }

  private fire(now: number): void {
    const alive = this.world.tanks.filter((t) => t.alive);
    if (alive.length < 2) {
      this.resetAt = now + 2500;
      return;
    }
    const rng = this.rng;
    const me = alive[Math.floor(rng() * alive.length)];
    const others = alive.filter((t) => t !== me);
    const target = others[Math.floor(rng() * others.length)];
    let best = { angle: 60, power: 500, d: Infinity };
    for (let angle = 20; angle <= 160; angle += 6) {
      for (let power = 250; power <= 1000; power += 50) {
        const hit = this.world.traceImpact(launchFor(me, angle, power));
        const d = Math.abs(hit.x - target.x) + (hit.offMap ? 1000 : 0);
        if (d < best.d) best = { angle, power, d };
      }
    }
    let angle = best.angle + Math.round((rng() - 0.5) * 6);
    let power = Math.round(best.power * (1 + (rng() - 0.5) * 0.08));
    let weapon = DEMO_WEAPONS[Math.floor(rng() * DEMO_WEAPONS.length)];
    if (weapon === "laser") {
      // Lasers go straight, so they only fire at someone level or higher up.
      const direct = Math.round((Math.atan2(target.y + 6 - (me.y + TURRET_Y), target.x - me.x) * 180) / Math.PI);
      if (direct >= 0 && direct <= 180) [angle, power] = [direct, 1000];
      else weapon = "missile";
    }
    this.tanks.get(me.id)!.angle = angle;
    this.world.fire({ shooterId: me.id, weapon, seed: randomSeed(), ...launchFor(me, angle, power) });
    this.shooting = true;
    this.shotStart = now;
    this.world.tick = 0;
  }
}
