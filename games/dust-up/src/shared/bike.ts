/**
 * The bike: two wheels (circles with mass and spin) and a chassis (the bike and rider as one
 * body, with position and angle), each wheel held to the chassis on its suspension axis by a
 * damped spring. The model Elasto Mania, X-Moto and Gravity Defied use.
 *
 * - Throttle drives the rear wheel against the chassis, up to a top speed, so the chassis feels
 *   the reaction (gas lifts the front, even in the air).
 * - Brake holds each wheel's spin to the chassis's, up to a torque.
 * - Lean shifts the rider's weight, which turns the chassis: on the ground it lifts or presses
 *   the front wheel, in the air it rotates the bike.
 * - Traction is friction at each wheel's contact, from the difference between its spin and its
 *   speed over the ground.
 *
 * It steps at a fixed 120 Hz: forces, then sequential impulses over the joints and contacts
 * (soft constraints), then positions. The solver starts each step from the last step's impulses
 * (warm starting), which are kept in the bike's state: without them a bike at rest crept
 * backwards, because ten iterations couldn't pass its weight through the tilted suspension.
 *
 * DETERMINISM: the client and the worker must get the same result bit for bit. Only + - * /,
 * Math.sqrt, abs, min, max, floor and round in here, never sin, cos, atan2, hypot, pow, exp or
 * `**`. The chassis angle is a unit vector (c, s), turned by a polynomial rotation and
 * renormalised with sqrt each step.
 */

import { DT, LEAN_MAX } from "./constants";
import { CONTACT_STRIDE, type Ground } from "./ground";

/** What the rider does this tick: small whole numbers, cheap to send and replay. */
export interface Input {
  /** 0 or 1. */
  throttle: number;
  /** 0 or 1. */
  brake: number;
  /** -LEAN_MAX (back) to LEAN_MAX (forward). */
  lean: number;
}

export const NO_INPUT: Readonly<Input> = { throttle: 0, brake: 0, lean: 0 };

export class Wheel {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  /** Spin angle in radians, 0 to 2π. Only for drawing. */
  a = 0;
  /** Spin rate in rad/s, anticlockwise positive: rolling forward (right) is negative. */
  w = 0;
}

/**
 * The solver's impulses from the last step, per wheel (rear then front): suspension across and
 * along, engine or drag, brake, then two contacts as (ground feature, normal, friction).
 */
const WARM_PER_WHEEL = 10;
const W_LAT = 0;
const W_SUS = 1;
const W_SPIN = 2;
const W_BRAKE = 3;
const W_CONTACT = 4;

export class Bike {
  /** Chassis centre of mass and velocity (m, m/s; y is up). */
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  /** Chassis angle as a unit vector: (1, 0) is level, facing right. */
  c = 1;
  s = 0;
  /** Chassis angular velocity, anticlockwise (nose up) positive. */
  w = 0;
  readonly rear = new Wheel();
  readonly front = new Wheel();
  /** Where the rider's weight is, -1 (back) to 1 (forward). It follows the lean input. */
  lean = 0;
  /** 1 once the rider's head or body has touched the ground, or the bike landed upside down. */
  crashed = 0;
  /** The solver's impulses from the last step (see WARM_PER_WHEEL). Part of the state. */
  readonly warm = new Float64Array(2 * WARM_PER_WHEEL);

  copyFrom(o: Bike): this {
    this.x = o.x;
    this.y = o.y;
    this.vx = o.vx;
    this.vy = o.vy;
    this.c = o.c;
    this.s = o.s;
    this.w = o.w;
    copyWheel(this.rear, o.rear);
    copyWheel(this.front, o.front);
    this.lean = o.lean;
    this.crashed = o.crashed;
    this.warm.set(o.warm);
    return this;
  }

  clone(): Bike {
    return new Bike().copyFrom(this);
  }
}

function copyWheel(to: Wheel, from: Wheel): void {
  to.x = from.x;
  to.y = from.y;
  to.vx = from.vx;
  to.vy = from.vy;
  to.a = from.a;
  to.w = from.w;
}

/** Every number in a bike's state, in a fixed order (for hashing and snapshots). */
export function bikeNumbers(b: Bike, out: number[] = []): number[] {
  out.push(b.x, b.y, b.vx, b.vy, b.c, b.s, b.w, b.lean, b.crashed);
  for (const wh of [b.rear, b.front]) out.push(wh.x, wh.y, wh.vx, wh.vy, wh.a, wh.w);
  for (const v of b.warm) out.push(v);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tuning. Metres, kilograms, seconds. Positions are in the chassis frame: x forward, y up, the
// origin at the centre of mass. Changing any of these changes the golden hash.

export const TUNE = {
  gravity: 11,
  chassisMass: 110,
  chassisInertia: 30,
  wheelMass: 10,
  wheelInertia: 0.6,
  wheelRadius: 0.34,

  /** Each wheel's position at static sag, and the direction its suspension extends in. */
  rearRest: [-0.7, -0.5],
  rearAxis: [0.25, -1],
  frontRest: [0.72, -0.5],
  frontAxis: [0.45, -0.9],
  /** Suspension travel along the axis from its top: sag, fully compressed, fully extended. */
  sag: 0.3,
  travelMin: 0.12,
  travelMax: 0.4,
  springK: 6000,
  springC: 650,

  tyreGrip: 1.1,
  topSpeed: 20,
  /** The rear wheel can't spin more than this much faster than the bike moves (m/s at the tyre). */
  overRev: 4,
  engineTorque: 330,
  /** Engine braking on the rear wheel and bearing drag on the front, off the throttle. */
  rearDrag: 12,
  frontDrag: 2,
  rearBrake: 220,
  frontBrake: 320,

  leanTorque: 330,
  /** How fast the rider's weight moves, in full leans per second. */
  leanRate: 8,
  airDrag: 0.25,
  spinDamping: 1,

  /** Rider colliders: head and body, centre and radius, and how far lean moves each. */
  head: [0.05, 0.95, 0.15],
  headLean: [0.22, -0.1],
  body: [-0.08, 0.42, 0.2],
  bodyLean: [0.15, 0],
  /** A skid plate under the frame, so the bike can't high-centre through a peak. */
  skid: [0.02, -0.4, 0.12],
  riderGrip: 0.6,
};

export type Tuning = typeof TUNE;

/** Values worked out from TUNE, once (and again after `retune`). */
interface Derived {
  imC: number;
  iiC: number;
  imW: number;
  iiW: number;
  /** Per wheel (rear, front): the top of its travel and its axis, in the chassis frame. */
  anchorX: [number, number];
  anchorY: [number, number];
  axisX: [number, number];
  axisY: [number, number];
  /** Spring rest length along the axis (past travelMax, so it's preloaded). */
  springRest: number;
}

let D: Derived = derive(TUNE);

function derive(t: Tuning): Derived {
  const axes = [t.rearAxis, t.frontAxis].map(([x, y]) => {
    const l = Math.sqrt(x * x + y * y);
    return [x / l, y / l];
  });
  const rests = [t.rearRest, t.frontRest];
  const load = (t.chassisMass * t.gravity) / 2;
  return {
    imC: 1 / t.chassisMass,
    iiC: 1 / t.chassisInertia,
    imW: 1 / t.wheelMass,
    iiW: 1 / t.wheelInertia,
    anchorX: [rests[0][0] - axes[0][0] * t.sag, rests[1][0] - axes[1][0] * t.sag],
    anchorY: [rests[0][1] - axes[0][1] * t.sag, rests[1][1] - axes[1][1] * t.sag],
    axisX: [axes[0][0], axes[1][0]],
    axisY: [axes[0][1], axes[1][1]],
    springRest: t.sag + load / t.springK,
  };
}

/** For tuning in the sandbox: change TUNE and work the derived values out again. */
export function retune(patch: Partial<Tuning>): void {
  Object.assign(TUNE, patch);
  D = derive(TUNE);
}

// ---------------------------------------------------------------------------------------------
// The solver's rows. Each is one constraint on the velocities of one wheel and the chassis:
// J·v + bias + gamma·acc = 0, with the accumulated impulse `acc` clamped to [lo, hi].

class Row {
  wheel: Wheel | null = null;
  jwx = 0;
  jwy = 0;
  jwa = 0;
  jcx = 0;
  jcy = 0;
  jca = 0;
  mass = 0;
  bias = 0;
  gamma = 0;
  lo = -Infinity;
  hi = Infinity;
  acc = 0;
  /** For friction: the normal row whose impulse bounds this one, times `mu`. */
  normal: Row | null = null;
  mu = 0;
  /** Where in bike.warm its impulse is kept between steps, or -1. */
  warm = -1;
}

const MAX_ROWS = 64;
const rows: Row[] = Array.from({ length: MAX_ROWS }, () => new Row());
let nRows = 0;

const ITERATIONS = 10;
/** Contacts are made this far out, so a fast wheel is stopped before it sinks in. */
const MARGIN = 0.1;
const SLOP = 0.005;
const BAUMGARTE = 0.25;
const MAX_PUSH = 2;
const LATERAL_HZ = 25;
const TAU = 6.283185307179586;

const contactBuf = new Float64Array(8 * CONTACT_STRIDE);

function addRow(wheel: Wheel | null, warm = -1): Row {
  const r = rows[nRows++];
  r.wheel = wheel;
  r.jwx = r.jwy = r.jwa = r.jcx = r.jcy = r.jca = 0;
  r.bias = r.gamma = r.acc = 0;
  r.lo = -Infinity;
  r.hi = Infinity;
  r.normal = null;
  r.warm = warm;
  return r;
}

/** J·M⁻¹·Jᵀ for a row. */
function stiffness(r: Row): number {
  let k = D.imC * (r.jcx * r.jcx + r.jcy * r.jcy) + D.iiC * r.jca * r.jca;
  if (r.wheel) k += D.imW * (r.jwx * r.jwx + r.jwy * r.jwy) + D.iiW * r.jwa * r.jwa;
  return k;
}

/** A spring and damper (k N/m, c N·s/m) on position error `err`, solved implicitly. */
function spring(r: Row, err: number, k: number, c: number): void {
  const gamma = 1 / (DT * (c + DT * k));
  r.gamma = gamma;
  r.mass = 1 / (stiffness(r) + gamma);
  r.bias = (k / (c + DT * k)) * err;
}

/** A stiff joint at `hz` with critical damping, scaled to the row's own mass. */
function joint(r: Row, err: number, hz: number): void {
  const m = 1 / stiffness(r);
  const omega = TAU * hz;
  spring(r, err, m * omega * omega, 2 * m * omega);
}

/** A one-sided limit (a contact or a bump stop): `gap` is how far it is from touching. */
function stop(r: Row, gap: number): void {
  r.mass = 1 / stiffness(r);
  if (gap > 0) r.bias = gap / DT;
  else r.bias = Math.max((BAUMGARTE * Math.min(gap + SLOP, 0)) / DT, -MAX_PUSH);
  r.lo = 0;
}

/**
 * A torque on a wheel's spin, between `lo` and `hi`, towards spin `target`: relative to the
 * chassis's (engine and brakes, whose reaction turns the chassis), or on its own (drag).
 */
function spinRow(wheel: Wheel, warm: number, target: number, lo: number, hi: number, onChassis = true): void {
  const r = addRow(wheel, warm);
  r.jwa = 1;
  r.jca = onChassis ? -1 : 0;
  r.mass = 1 / stiffness(r);
  r.bias = -target;
  r.lo = lo * DT;
  r.hi = hi * DT;
}

function friction(r: Row, normal: Row, mu: number): void {
  r.mass = 1 / stiffness(r);
  r.normal = normal;
  r.mu = mu;
}

/** A collider on the chassis, at (lx, ly) in its frame with radius rad, against the ground. */
function chassisContacts(b: Bike, g: Ground, lx: number, ly: number, rad: number, mu: number): void {
  const px = b.x + b.c * lx - b.s * ly;
  const py = b.y + b.s * lx + b.c * ly;
  const n = g.contacts(px, py, rad + MARGIN, contactBuf, 4);
  for (let i = 0; i < n && nRows + 2 <= MAX_ROWS; i++) {
    const nx = contactBuf[i * CONTACT_STRIDE];
    const ny = contactBuf[i * CONTACT_STRIDE + 1];
    const d = contactBuf[i * CONTACT_STRIDE + 2];
    const rx = px - rad * nx - b.x;
    const ry = py - rad * ny - b.y;
    const nr = addRow(null);
    nr.jcx = nx;
    nr.jcy = ny;
    nr.jca = rx * ny - ry * nx;
    stop(nr, d - rad);
    const tr = addRow(null);
    tr.jcx = ny;
    tr.jcy = -nx;
    tr.jca = rx * -nx - ry * ny;
    friction(tr, nr, mu);
  }
}

/** Whether a rider collider at (lx, ly) with radius rad is touching the ground. */
function touches(b: Bike, g: Ground, lx: number, ly: number, rad: number): boolean {
  const px = b.x + b.c * lx - b.s * ly;
  const py = b.y + b.s * lx + b.c * ly;
  const n = g.contacts(px, py, rad, contactBuf, 4);
  for (let i = 0; i < n; i++) if (contactBuf[i * CONTACT_STRIDE + 2] < rad) return true;
  return false;
}

/** A rider collider's centre in the chassis frame (TUNE.head or TUNE.body), moved by lean. */
export function riderX(b: Bike, at: readonly number[], shift: readonly number[]): number {
  return at[0] + b.lean * shift[0];
}

export function riderY(b: Bike, at: readonly number[], shift: readonly number[]): number {
  return at[1] + Math.abs(b.lean) * shift[1];
}

/** Steps the bike one tick (1/120 s). A crashed bike ignores its input and tumbles. */
export function stepBike(b: Bike, input: Readonly<Input>, g: Ground): void {
  const t = TUNE;
  const h = DT;
  const crashed = b.crashed === 1;
  const throttle = crashed ? 0 : input.throttle;
  const brake = crashed ? 0 : input.brake;
  const leanTarget = crashed ? 0 : input.lean / LEAN_MAX;

  // The rider's weight moves towards the lean input.
  const maxStep = t.leanRate * h;
  b.lean += Math.max(-maxStep, Math.min(maxStep, leanTarget - b.lean));

  // Forces.
  b.vy -= t.gravity * h;
  b.rear.vy -= t.gravity * h;
  b.front.vy -= t.gravity * h;
  b.w += D.iiC * -b.lean * t.leanTorque * h;
  b.w -= b.w * t.spinDamping * h;
  const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
  const drag = Math.min(1, t.airDrag * speed * h * D.imC);
  b.vx -= b.vx * drag;
  b.vy -= b.vy * drag;

  // Joints: each wheel on its suspension axis.
  nRows = 0;
  const c = b.c;
  const s = b.s;
  for (let k = 0; k < 2; k++) {
    const wh = k === 0 ? b.rear : b.front;
    const base = k * WARM_PER_WHEEL;
    const ax = b.x + c * D.anchorX[k] - s * D.anchorY[k];
    const ay = b.y + s * D.anchorX[k] + c * D.anchorY[k];
    const dx = c * D.axisX[k] - s * D.axisY[k];
    const dy = s * D.axisX[k] + c * D.axisY[k];
    const rx = wh.x - b.x;
    const ry = wh.y - b.y;
    const ox = wh.x - ax;
    const oy = wh.y - ay;

    // Across the axis: held rigidly (a very stiff spring).
    const lat = addRow(wh, base + W_LAT);
    lat.jwx = -dy;
    lat.jwy = dx;
    lat.jcx = dy;
    lat.jcy = -dx;
    lat.jca = -dy * ry - dx * rx;
    joint(lat, -dy * ox + dx * oy, LATERAL_HZ);

    // Along it: the suspension spring, and bump stops at each end of the travel.
    const along = dx * ox + dy * oy;
    const sus = addRow(wh, base + W_SUS);
    sus.jwx = dx;
    sus.jwy = dy;
    sus.jcx = -dx;
    sus.jcy = -dy;
    sus.jca = dx * ry - dy * rx;
    spring(sus, along - D.springRest, t.springK, t.springC);
    if (along - t.travelMin < MARGIN) {
      const lo = addRow(wh);
      lo.jwx = dx;
      lo.jwy = dy;
      lo.jcx = -dx;
      lo.jcy = -dy;
      lo.jca = sus.jca;
      stop(lo, along - t.travelMin);
    }
    if (t.travelMax - along < MARGIN) {
      const hi = addRow(wh);
      hi.jwx = -dx;
      hi.jwy = -dy;
      hi.jcx = dx;
      hi.jcy = dy;
      hi.jca = -sus.jca;
      stop(hi, t.travelMax - along);
    }
  }

  // Engine, brakes and drag on the wheels' spin. Drag doesn't turn the chassis.
  const R = t.wheelRadius;
  if (throttle) {
    const forward = Math.max(0, b.vx * c + b.vy * s);
    spinRow(b.rear, W_SPIN, -Math.min(t.topSpeed, forward + t.overRev) / R, -t.engineTorque, 0);
  } else spinRow(b.rear, W_SPIN, 0, -t.rearDrag, t.rearDrag, false);
  spinRow(b.front, WARM_PER_WHEEL + W_SPIN, 0, -t.frontDrag, t.frontDrag, false);
  if (brake) {
    spinRow(b.rear, W_BRAKE, 0, -t.rearBrake, t.rearBrake);
    spinRow(b.front, WARM_PER_WHEEL + W_BRAKE, 0, -t.frontBrake, t.frontBrake);
  }

  // Wheels on the ground: no sinking in, and grip from slip at the contact.
  const upX = -s;
  const upY = c;
  let upsideDown = false;
  for (let k = 0; k < 2; k++) {
    const wh = k === 0 ? b.rear : b.front;
    const base = k * WARM_PER_WHEEL + W_CONTACT;
    const n = g.contacts(wh.x, wh.y, R + MARGIN, contactBuf, 4);
    for (let i = 0; i < n && nRows + 2 <= MAX_ROWS; i++) {
      const nx = contactBuf[i * CONTACT_STRIDE];
      const ny = contactBuf[i * CONTACT_STRIDE + 1];
      const gap = contactBuf[i * CONTACT_STRIDE + 2] - R;
      const feature = contactBuf[i * CONTACT_STRIDE + 3];
      if (gap < SLOP && upX * nx + upY * ny < 0) upsideDown = true;
      // The first two contacts keep their impulses between steps, matched by ground feature.
      const slot = i < 2 ? base + 3 * i : -1;
      const nr = addRow(wh, slot < 0 ? -1 : slot + 1);
      nr.jwx = nx;
      nr.jwy = ny;
      stop(nr, gap);
      const tr = addRow(wh, slot < 0 ? -1 : slot + 2);
      tr.jwx = ny;
      tr.jwy = -nx;
      tr.jwa = R;
      friction(tr, nr, t.tyreGrip);
      if (slot >= 0) {
        const old = b.warm[base] === feature ? base : b.warm[base + 3] === feature ? base + 3 : -1;
        nr.acc = old < 0 ? 0 : b.warm[old + 1];
        tr.acc = old < 0 ? 0 : b.warm[old + 2];
        contactFeature[k * 2 + i] = feature;
      }
    }
    for (let i = n; i < 2; i++) contactFeature[k * 2 + i] = 0;
  }

  // The rider: the skid plate always, and head and body once crashed (until then they crash it).
  chassisContacts(b, g, t.skid[0], t.skid[1], t.skid[2], t.riderGrip);
  if (crashed) {
    chassisContacts(b, g, riderX(b, t.head, t.headLean), riderY(b, t.head, t.headLean), t.head[2], t.riderGrip);
    chassisContacts(b, g, riderX(b, t.body, t.bodyLean), riderY(b, t.body, t.bodyLean), t.body[2], t.riderGrip);
  }

  warmStart(b);
  solve(b);
  keepImpulses(b);
  integrate(b);

  if (
    !crashed &&
    (upsideDown ||
      touches(b, g, riderX(b, t.head, t.headLean), riderY(b, t.head, t.headLean), t.head[2]) ||
      touches(b, g, riderX(b, t.body, t.bodyLean), riderY(b, t.body, t.bodyLean), t.body[2]))
  )
    b.crashed = 1;
}

/** This step's ground feature for each wheel's first two contacts (0 for none). */
const contactFeature = new Float64Array(4);

/** Starts each kept row from last step's impulse (contacts already have theirs), within its limits. */
function warmStart(b: Bike): void {
  for (let i = 0; i < nRows; i++) {
    const r = rows[i];
    if (r.warm < 0) continue;
    let acc = r.warm % WARM_PER_WHEEL >= W_CONTACT ? r.acc : b.warm[r.warm];
    const lo = r.normal ? -r.mu * r.normal.acc : r.lo;
    const hi = r.normal ? r.mu * r.normal.acc : r.hi;
    acc = acc < lo ? lo : acc > hi ? hi : acc;
    r.acc = acc;
    apply(b, r, acc);
  }
}

/** Keeps this step's impulses for the next (rows that weren't used this step keep nothing). */
function keepImpulses(b: Bike): void {
  b.warm.fill(0);
  for (let i = 0; i < nRows; i++) {
    const r = rows[i];
    if (r.warm >= 0) b.warm[r.warm] = r.acc;
  }
  for (let k = 0; k < 2; k++)
    for (let i = 0; i < 2; i++) b.warm[k * WARM_PER_WHEEL + W_CONTACT + 3 * i] = contactFeature[k * 2 + i];
}

function apply(b: Bike, r: Row, lam: number): void {
  b.vx += D.imC * r.jcx * lam;
  b.vy += D.imC * r.jcy * lam;
  b.w += D.iiC * r.jca * lam;
  const wh = r.wheel;
  if (wh) {
    wh.vx += D.imW * r.jwx * lam;
    wh.vy += D.imW * r.jwy * lam;
    wh.w += D.iiW * r.jwa * lam;
  }
}

function solve(b: Bike): void {
  for (let it = 0; it < ITERATIONS; it++) {
    for (let i = 0; i < nRows; i++) {
      const r = rows[i];
      const wh = r.wheel;
      let jv = r.jcx * b.vx + r.jcy * b.vy + r.jca * b.w + r.bias + r.gamma * r.acc;
      if (wh) jv += r.jwx * wh.vx + r.jwy * wh.vy + r.jwa * wh.w;
      let lo = r.lo;
      let hi = r.hi;
      if (r.normal) {
        hi = r.mu * r.normal.acc;
        lo = -hi;
      }
      const old = r.acc;
      let acc = old - r.mass * jv;
      if (acc < lo) acc = lo;
      else if (acc > hi) acc = hi;
      r.acc = acc;
      apply(b, r, acc - old);
    }
  }
}

function integrate(b: Bike): void {
  const h = DT;
  b.x += h * b.vx;
  b.y += h * b.vy;
  // Turn (c, s) by θ = w·h: Taylor series for cos and sin, then renormalise.
  const th = b.w * h;
  const th2 = th * th;
  const cr = 1 - th2 * (0.5 - th2 / 24);
  const sr = th * (1 - (th2 / 6) * (1 - th2 / 20));
  const nc = b.c * cr - b.s * sr;
  const ns = b.s * cr + b.c * sr;
  const inv = 1 / Math.sqrt(nc * nc + ns * ns);
  b.c = nc * inv;
  b.s = ns * inv;
  moveWheel(b.rear);
  moveWheel(b.front);
}

function moveWheel(wh: Wheel): void {
  wh.x += DT * wh.vx;
  wh.y += DT * wh.vy;
  wh.a += DT * wh.w;
  if (wh.a < 0 || wh.a >= TAU) wh.a -= Math.floor(wh.a / TAU) * TAU;
}

/**
 * Puts the bike upright and still at x, wheels resting on the ground at their static sag.
 */
export function placeBike(b: Bike, x: number, g: Ground): void {
  const t = TUNE;
  const rx = t.rearRest[0];
  const fx = t.frontRest[0];
  const groundY = Math.max(g.heightAt(x + rx), g.heightAt(x + fx));
  b.x = x;
  b.y = groundY + t.wheelRadius - t.rearRest[1] + 0.005;
  b.vx = b.vy = b.w = 0;
  b.c = 1;
  b.s = 0;
  b.lean = 0;
  b.crashed = 0;
  b.warm.fill(0);
  for (let k = 0; k < 2; k++) {
    const wh = k === 0 ? b.rear : b.front;
    const rest = k === 0 ? t.rearRest : t.frontRest;
    wh.x = b.x + rest[0];
    wh.y = b.y + rest[1];
    wh.vx = wh.vy = wh.w = 0;
    wh.a = 0;
  }
}

/** Where the suspension of wheel k (0 rear, 1 front) is attached, and its axis, in world space. */
export function suspension(b: Bike, k: number): { ax: number; ay: number; dx: number; dy: number } {
  const lx = D.anchorX[k];
  const ly = D.anchorY[k];
  const dx = D.axisX[k];
  const dy = D.axisY[k];
  return {
    ax: b.x + b.c * lx - b.s * ly,
    ay: b.y + b.s * lx + b.c * ly,
    dx: b.c * dx - b.s * dy,
    dy: b.s * dx + b.c * dy,
  };
}
