/**
 * The milestone 1 sandbox: one bike on the hand-made course, keyboard controls, and a tuning
 * panel (add ?tune to the URL). The sim is stepped from the clock, not from animation frames:
 * every frame and every 50 ms it steps until its tick catches up, so a background tab keeps
 * time too.
 */

import { setStorePrefix, setText, store } from "@warrick/kit/client/dom";
import { Bike, TUNE, retune, type Tuning } from "../shared/bike";
import { RESPAWN_TICKS, TICK_HZ } from "../shared/constants";
import { Ride, encodeInput, rideHash, startRide, stepRide, type InputEvent, type RideInput } from "../shared/ride";
import { sandboxCourse } from "../shared/sandbox";
import { Keys } from "./input";
import { Renderer, lerpBike } from "./render";

const course = sandboxCourse();
const renderer = new Renderer(document.getElementById("view") as HTMLCanvasElement);
const $ = (id: string) => document.getElementById(id) as HTMLElement;

let ride = startRide(course);
const prev = new Ride().copyFrom(ride);
const pose = new Bike();
/** When tick 0 was, on the performance clock. */
let start = performance.now();
/** Every input change of this run, to replay it (the golden test's fixture is one of these). */
let log: InputEvent[] = [];
let lastBits = -1;
let lastLean = 0;
const input: RideInput = { throttle: 0, brake: 0, lean: 0, respawn: 0 };
/** A scripted run for testing the feel: [seconds from its start, bits, lean], in order. */
let script: { from: number; steps: InputEvent[] } | null = null;
/** A dev aid: a function that rides the bike in place of the keyboard. */
let pilot: ((bike: Bike, into: RideInput) => void) | null = null;

setStorePrefix("du");
/** The best finish on the sandbox course in this browser, in ticks (0: none yet). */
let best = Number(store("sandboxBest")) || 0;
let finishedShown = false;

const keys = new Keys(window, (code) => {
  if (code === "Enter") restart();
});

function restart(): void {
  ride = startRide(course);
  prev.copyFrom(ride);
  start = performance.now();
  log = [];
  lastBits = -1;
  finishedShown = false;
  script = null;
}

// More than this far behind (a long-hidden tab), the clock waits for the sim instead.
const MAX_CATCH_UP = TICK_HZ * 10;

function readInput(): void {
  if (pilot) return pilot(ride.bike, input);
  if (script) {
    const at = ride.tick - script.from;
    let cur: InputEvent | null = null;
    for (const e of script.steps) if (e[0] * TICK_HZ <= at) cur = e;
    if (cur) {
      input.throttle = cur[1] & 1;
      input.brake = (cur[1] >> 1) & 1;
      input.respawn = (cur[1] >> 2) & 1;
      input.lean = cur[2];
    }
    const last = script.steps[script.steps.length - 1];
    if (at > last[0] * TICK_HZ) script = null;
    return;
  }
  keys.read(input);
}

function advance(now: number): void {
  let target = Math.floor(((now - start) * TICK_HZ) / 1000);
  if (target - ride.tick > MAX_CATCH_UP) {
    target = ride.tick + MAX_CATCH_UP;
    start = now - (target * 1000) / TICK_HZ;
  }
  if (target <= ride.tick) return;
  while (ride.tick < target) {
    readInput();
    const bits = encodeInput(input);
    if (bits !== lastBits || input.lean !== lastLean) {
      log.push([ride.tick, bits, input.lean]);
      lastBits = bits;
      lastLean = input.lean;
    }
    prev.copyFrom(ride);
    stepRide(ride, input, course);
  }
  keys.settle();
}

let lastFrame = performance.now();
let frames = 0;
let perfAt = performance.now();

function frame(now: number): void {
  draw(now);
  requestAnimationFrame(frame);
}

function draw(now: number): void {
  advance(now);
  const ft = ((now - start) * TICK_HZ) / 1000;
  const alpha = Math.max(0, Math.min(1, ft - ride.tick));
  lerpBike(pose, prev.bike, ride.bike, alpha);
  renderer.follow(pose, Math.min(0.1, (now - lastFrame) / 1000));
  renderer.draw(course, pose, ride.checkpoint);
  hud(now);
  lastFrame = now;
  frames++;
}

function clock(ticks: number): string {
  const cs = Math.floor((ticks * 100) / TICK_HZ);
  const m = Math.floor(cs / 6000);
  const s = Math.floor(cs / 100) % 60;
  return `${m}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

function hud(now: number): void {
  const b = ride.bike;
  setText($("clock"), clock(ride.finishTick >= 0 ? ride.finishTick : ride.tick));
  setText($("speed"), `${Math.round(Math.hypot(b.vx, b.vy) * 3.6)} km/h`);
  setText($("checkpoint"), `CP ${ride.checkpoint}/${course.checkpoints.length - 1}`);

  const banner = $("banner");
  let html = "";
  if (input.respawn) html = "Held at the checkpoint<small>Let go of R to ride</small>";
  else if (b.crashed) {
    const left = (RESPAWN_TICKS - ride.crashTicks) / TICK_HZ;
    html = `Crashed!<small>Back at the checkpoint in ${left.toFixed(1)} s</small>`;
  } else if (ride.finishTick >= 0) {
    if (!finishedShown) {
      finishedShown = true;
      if (!best || ride.finishTick < best) {
        best = ride.finishTick;
        store("sandboxBest", String(best));
      }
    }
    html = `Finished in ${clock(ride.finishTick)}<small>Best ${clock(best)} · Enter to ride again</small>`;
  }
  if (banner.innerHTML !== html) banner.innerHTML = html;
  banner.hidden = !html;

  // A step's cost is too small for the page's clock to time here: check.html measures it.
  if (now - perfAt >= 1000) {
    setText($("perf"), `${Math.round((frames * 1000) / (now - perfAt))} fps`);
    frames = 0;
    perfAt = now;
  }
}

// The tuning panel: sliders over TUNE. Changing the tuning mid-run means the run's log no longer replays.
const SLIDERS: [keyof Tuning, number, number, number][] = [
  ["gravity", 6, 20, 0.1],
  ["engineTorque", 80, 600, 5],
  ["topSpeed", 8, 35, 0.5],
  ["tyreGrip", 0.4, 2, 0.05],
  ["leanTorque", 50, 800, 10],
  ["leanRate", 1, 20, 0.5],
  ["spinDamping", 0, 3, 0.05],
  ["chassisInertia", 8, 50, 1],
  ["springK", 1500, 20000, 100],
  ["springC", 50, 3000, 25],
  ["sag", 0.18, 0.38, 0.01],
  ["rearBrake", 0, 800, 10],
  ["frontBrake", 0, 800, 10],
  ["airDrag", 0, 1.5, 0.05],
];

function tunePanel(): void {
  const panel = $("tune");
  panel.hidden = false;
  const initial = { ...TUNE };
  for (const [key, min, max, step] of SLIDERS) {
    const label = document.createElement("label");
    const name = document.createElement("span");
    name.textContent = key;
    const value = document.createElement("span");
    value.textContent = String(TUNE[key]);
    const slider = document.createElement("input");
    slider.type = "range";
    Object.assign(slider, { min, max, step, value: TUNE[key] });
    slider.addEventListener("input", () => {
      retune({ [key]: Number(slider.value) });
      value.textContent = slider.value;
    });
    // Let the arrow keys ride the bike, not move the slider.
    slider.addEventListener("pointerup", () => slider.blur());
    label.append(name, value, slider);
    panel.append(label);
  }
  const copy = document.createElement("button");
  copy.textContent = "Copy changes";
  copy.addEventListener("click", () => {
    const changed = Object.fromEntries(
      SLIDERS.map(([k]) => k)
        .filter((k) => TUNE[k] !== initial[k])
        .map((k) => [k, TUNE[k]]),
    );
    void navigator.clipboard.writeText(JSON.stringify(changed));
    copy.blur();
  });
  panel.append(copy);
}

if (new URLSearchParams(location.search).has("tune")) tunePanel();

// Dev hooks, for scripted runs and capturing logs from the console.
Object.assign(window, {
  du: {
    course,
    renderer,
    TUNE,
    retune,
    restart,
    get ride() {
      return ride;
    },
    log: () => log.slice(),
    hash: () => rideHash(ride),
    /** Rides a script: [seconds from now, bits (1 gas, 2 brake, 4 respawn), lean]. */
    drive(steps: InputEvent[]) {
      script = { from: ride.tick, steps };
    },
    /** Rides with a function of the bike, or the keyboard again with null. */
    pilot(fn: typeof pilot) {
      pilot = fn;
    },
  },
});

// The clock steps the sim even when animation frames stop (a background tab). A hidden preview
// pane doesn't run them either, so then this draws too.
setInterval(() => {
  const now = performance.now();
  if (now - lastFrame > 100) draw(now);
  else advance(now);
}, 50);
requestAnimationFrame(frame);
