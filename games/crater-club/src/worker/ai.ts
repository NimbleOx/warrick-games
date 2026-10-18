import { MAX_POWER, TANK_H, TURRET_Y } from "../shared/constants";
import { powerCap, type Aim, type CpuLevel, type GameState, type PlayerState, type TankState } from "../shared/protocol";
import type { Rng } from "@warrick/kit/shared/rng";
import { launchFor, type World } from "../shared/sim";
import { WEAPONS, shopDef, weaponCount, type ShopId, type WeaponId } from "../shared/weapons";
import { worldFromState } from "../shared/world-state";

const ERROR: Record<CpuLevel, { angle: number; power: number }> = {
  easy: { angle: 11, power: 0.14 },
  normal: { angle: 4, power: 0.055 },
  hard: { angle: 1.5, power: 0.02 },
};

/**
 * Easy CPUs bracket, like a human: each shot in a row that missed the same tank takes a quarter off
 * their aim error, down to a third of it. (Without it, two easy CPUs could miss each other for 30
 * turns, and one round in seven between them ended in the stalemate draw.)
 */
const BRACKET = 0.75;
const BRACKET_FLOOR = 0.33;

const ATTACK_WEAPONS: WeaponId[] = [
  "deaths_head",
  "nuke",
  "hot_napalm",
  "mirv",
  "baby_nuke",
  "funky_bomb",
  "napalm",
  "sandhog",
  "leapfrog",
  "laser",
  "missile",
  "roller",
  "baby_missile",
];

/**
 * Weapons that don't go off where they land: fire runs downhill, sandhogs dig on, lasers go
 * straight. The CPU plays the whole shot through before it picks one of these.
 */
const PLAYED_THROUGH = new Set<WeaponId>(["hot_napalm", "napalm", "sandhog", "laser"]);

/**
 * Search angle/power space for the shot that lands closest to a target, then fumble it a bit.
 * An easy CPU notes the shot in `me.lastShot`, to steady its aim if it misses.
 */
export function chooseCpuShot(s: GameState, me: PlayerState, level: CpuLevel, rng: Rng): Aim {
  const world = worldFromState(s);
  const tank = me.tank!;
  const enemies = s.players.filter((p) => p.id !== me.id && p.tank?.alive);
  const maxPower = powerCap(s, tank);

  // Easy CPUs pick a random victim; the others go for the closest or weakest.
  let target = enemies[Math.floor(rng() * enemies.length)];
  if (!target) return { ...me.aim, weapon: "baby_missile" };
  if (level !== "easy") {
    target = enemies.reduce((best, p) => {
      const cost = (p: PlayerState) => Math.abs(p.tank!.x - tank.x) + p.tank!.health * 3;
      return cost(p) < cost(best) ? p : best;
    }, target);
  }
  const tx = target.tank!.x;
  const ty = target.tank!.y + TANK_H / 2;

  const score = (angle: number, power: number): number => {
    const hit = trace(world, tank, angle, power);
    if (hit.tankId === target.id) return 0;
    let d = Math.hypot(hit.x - tx, hit.y - ty);
    if (hit.offMap) d += 2000;
    if (Math.hypot(hit.x - tank.x, hit.y - tank.y) < 45) d += 1500;
    return d;
  };

  // Angles go up from the target's side, so the search meets its shots in the same order facing
  // left or right, and among shots that hit it keeps the flattest. (Counting from 0° either way, a
  // tank firing left picked a steep lob, which aim error and wind throw off far more.)
  const dir = tx < tank.x ? -1 : 1;
  const candidates: { angle: number; power: number; d: number }[] = [];
  for (let up = 5; up <= 175; up += 5) {
    const angle = dir > 0 ? up : 180 - up;
    for (let power = 100; power <= maxPower; power += 50) {
      candidates.push({ angle, power, d: score(angle, power) });
    }
  }
  candidates.sort((a, b) => a.d - b.d);
  let best = candidates[0];
  for (const c of candidates.slice(0, 3)) {
    for (let da = -4; da <= 4; da++) {
      for (let dp = -50; dp <= 50; dp += 10) {
        const angle = c.angle + da * dir;
        const power = c.power + dp;
        if (angle < 0 || angle > 180 || power < 0 || power > maxPower) continue;
        const d = score(angle, power);
        if (d < best.d) best = { angle, power, d };
      }
    }
  }

  const distToTarget = Math.abs(tx - tank.x);
  const owned = ATTACK_WEAPONS.filter((w) => weaponCount(me.inventory, w) > 0);
  const aimFor = (w: WeaponId) => (w === "laser" ? laserAim(tank, target.tank!, maxPower) : best);
  let choice: Aim = { angle: best.angle, power: best.power, weapon: "baby_missile" };
  if (level === "easy") {
    const weapon = owned[Math.floor(rng() * owned.length)] ?? "baby_missile";
    choice = { ...(aimFor(weapon) ?? best), weapon };
  } else {
    for (const weapon of owned) {
      if (PLAYED_THROUGH.has(weapon)) {
        const aim = aimFor(weapon);
        if (!aim) continue;
        const out = playThrough(s, me, { ...aim, weapon });
        if (out.self > 0 || out.enemies < 15) continue;
        choice = { ...aim, weapon };
        break;
      }
      if (distToTarget > WEAPONS[weapon].radius + 30) {
        choice = { angle: best.angle, power: best.power, weapon };
        break;
      }
    }
  }

  // If the target's health and shield are as they were at the last shot, that shot missed.
  let steady = 1;
  if (level === "easy") {
    const life = target.tank!.health + target.tank!.shield;
    const last = me.lastShot;
    const misses = last && last.target === target.id && last.life === life ? last.misses + 1 : 0;
    me.lastShot = { target: target.id, life, misses };
    steady = Math.max(BRACKET_FLOOR, BRACKET ** misses);
  }

  const err = ERROR[level];
  const angle = Math.round(choice.angle + (rng() * 2 - 1) * err.angle * steady);
  const power = Math.round(choice.power * (1 + (rng() * 2 - 1) * err.power * steady));
  return {
    angle: Math.min(180, Math.max(0, angle)),
    power: Math.min(maxPower, Math.max(0, power)),
    weapon: choice.weapon,
  };
}

/** Point the barrel straight at the target, with power enough for the beam to reach a little past it. */
function laserAim(tank: TankState, target: TankState, maxPower: number): { angle: number; power: number } | null {
  const dx = target.x - tank.x;
  const dy = target.y + TANK_H / 2 + 2 - (tank.y + TURRET_Y);
  const angle = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
  const power = Math.ceil((((Math.hypot(dx, dy) + 40) / (WEAPONS.laser.reach ?? 1)) * MAX_POWER) / 10) * 10;
  if (angle < -5 || angle > 185 || power > maxPower) return null;
  return { angle: Math.min(180, Math.max(0, angle)), power };
}

/** The damage a shot would do, to the shooter and to everyone else, played through to the end. */
function playThrough(s: GameState, me: PlayerState, aim: Aim): { self: number; enemies: number } {
  const world = worldFromState(s);
  world.fire({ shooterId: me.id, weapon: aim.weapon, seed: 1, ...launchFor(me.tank!, aim.angle, aim.power) });
  world.runToEnd();
  const out = { self: 0, enemies: 0 };
  for (const ev of world.events) {
    if (ev.type === "damage") out[ev.id === me.id ? "self" : "enemies"] += ev.amount;
  }
  return out;
}

function trace(world: World, tank: { x: number; y: number }, angle: number, power: number) {
  return world.traceImpact(launchFor(tank, angle, power));
}

const CPU_WISHLIST: ShopId[] = [
  "missile",
  "baby_nuke",
  "mirv",
  "funky_bomb",
  "leapfrog",
  "roller",
  "nuke",
  "deaths_head",
  "napalm",
  "hot_napalm",
  "sandhog",
  "laser",
];

export function cpuShop(p: PlayerState): void {
  const buy = (id: ShopId) => {
    const def = shopDef(id);
    if (p.money < def.price) return false;
    p.money -= def.price;
    p.inventory[id] = (p.inventory[id] ?? 0) + def.bundle;
    return true;
  };
  if (!p.inventory.shield && p.money > 9000) buy("shield");
  if (!p.inventory.parachute && p.money > 4000) buy("parachute");
  for (let i = 0; i < 6; i++) {
    const affordable = CPU_WISHLIST.filter((id) => shopDef(id).price <= p.money);
    if (affordable.length === 0) break;
    buy(affordable[Math.floor(Math.random() * affordable.length)]);
  }
}
