import { describe, expect, it } from "vitest";
import { Predictor, BulletField, ServerClock, Timeline, pointAlong } from "../src/client/predict";
import { MAZE_LOOPINESS, TICK_MS } from "../src/shared/constants";
import { generateMaze, pickSpawns } from "../src/shared/maze";
import { mulberry32 } from "@warrick/kit/shared/rng";
import { World, startingTanks } from "../src/shared/sim";

/**
 * A server world and a predicting client, with messages delayed by `up`/`down` ticks (plus jitter), the
 * server's tick landing `phase` of the way between client ticks. Returns every reconcile error.
 */
function simulate(opts: {
  up: number;
  down: number;
  jitter: number;
  phase: number;
  seed: number;
  ticks: number;
  quietAfter?: number;
}) {
  const rng = mulberry32(opts.seed);
  const maze = generateMaze(mulberry32(opts.seed), 9, 6, MAZE_LOOPINESS);
  const world = new World(maze, { tick: 0, nextId: 1, tanks: startingTanks(["me"], pickSpawns(maze, 1, rng)), bullets: [] });
  const server = { bits: 0, seq: 0, age: 0 };
  const client = new Predictor();
  const t0 = world.tanks[0];
  client.reset({ x: t0.x, y: t0.y, h: t0.h, tt: t0.tt }, 0, 0);

  type Ev = { at: number; n: number; run: () => void };
  const queue: Ev[] = [];
  let made = 0;
  const at = (time: number, run: () => void) => queue.push({ at: time, n: made++, run });
  const errors: number[] = [];
  let seq = 0;
  let bits = 0;
  // A WebSocket delivers in order: jitter can delay a message but never let a later one overtake it.
  let lastUp = 0;
  let lastDown = 0;

  for (let t = 0; t < opts.ticks; t++) {
    // Client: deliver frames that have arrived, maybe change input, then step.
    for (const ev of queue.splice(0).sort((a, b) => a.at - b.at || a.n - b.n)) {
      if (ev.at <= t) ev.run();
      else queue.push(ev);
    }
    const quiet = opts.quietAfter !== undefined && t >= opts.quietAfter;
    if (quiet ? bits !== 0 : rng() < 0.15) {
      bits = quiet ? 0 : Math.floor(rng() * 16);
      seq++;
      client.input(seq, bits);
      const s = seq;
      const b = bits;
      lastUp = Math.max(lastUp, t + opts.up + rng() * opts.jitter);
      at(lastUp, () => {
        if (s > server.seq) Object.assign(server, { seq: s, bits: b, age: 0 });
      });
    }
    client.step(world.walls.tank, []);

    // Server tick, a fraction of a tick later.
    at(t + opts.phase, () => {
      world.step([server.bits]);
      server.age++;
      const tk = world.tanks[0];
      const pose = { x: tk.x, y: tk.y, h: tk.h, tt: tk.tt };
      const { seq: s, age } = server;
      lastDown = Math.max(lastDown, t + opts.phase + opts.down + rng() * opts.jitter);
      at(lastDown, () => {
        errors.push(client.reconcile(pose, s, age, world.walls.tank, []));
      });
    });
  }
  return { errors, client, world };
}

describe("prediction", () => {
  for (const [name, o] of [
    ["typical latency", { up: 2, down: 2, jitter: 0, phase: 0.4 }],
    ["high latency", { up: 6, down: 5, jitter: 0, phase: 0.7 }],
    ["almost none", { up: 0.05, down: 0.05, jitter: 0, phase: 0.1 }],
    ["jittery", { up: 2, down: 2, jitter: 3, phase: 0.5 }],
  ] as const) {
    it(`agrees with the server exactly under ${name}`, () => {
      for (let seed = 1; seed <= 5; seed++) {
        const { errors } = simulate({ ...o, seed, ticks: 600 });
        expect(errors.length).toBeGreaterThan(500);
        const off = errors.filter((e) => e !== 0);
        // Steady latency: the server holds each input exactly as long as we did, so we're never wrong.
        // Jitter changes how long it holds them, so there are corrections, but small ones.
        if (o.jitter === 0) expect(off, `seed ${seed}`).toEqual([]);
        else expect(Math.max(...off)).toBeLessThan(40);
      }
    });
  }

  it("ends up where the server is once input stops", () => {
    const { client, world } = simulate({ up: 3, down: 3, jitter: 2, phase: 0.5, seed: 9, ticks: 400, quietAfter: 300 });
    expect(client.pose).toMatchObject({ x: world.tanks[0].x, y: world.tanks[0].y, h: world.tanks[0].h });
  });
});

describe("client helpers", () => {
  it("walks a polyline by fraction", () => {
    expect(pointAlong([0, 0, 10, 0, 10, 10], 0.75)).toEqual({ x: 10, y: 5 });
    expect(pointAlong([0, 0, 10, 0], 0)).toEqual({ x: 0, y: 0 });
  });

  it("flies bullets like the world does", () => {
    const maze = generateMaze(mulberry32(4), 9, 6, MAZE_LOOPINESS);
    const world = new World(maze, {
      tick: 0,
      nextId: 1,
      tanks: startingTanks(["a", "b"], pickSpawns(maze, 2, mulberry32(4))),
      bullets: [],
    });
    const field = new BulletField(world.walls.bullet);
    for (let t = 0; t < 400; t++) {
      if (t % 20 === 0) world.requestFire(t % 40 ? 0 : 1);
      for (const e of world.step([t % 7 === 0 ? 4 : 1, 8])) {
        if (e.k === "fire") field.add(e.b, world.tick);
        if (e.k === "hit") field.remove(e.b);
      }
      // The client may run a few ticks behind and catch up in one go.
      if (t % 3 === 0) field.advance(world.tick);
      if (t % 3 === 0) {
        expect(field.ids().sort()).toEqual(world.bullets.map((b) => b.id).sort());
        for (const b of world.bullets) expect(field.get(b.id)).toEqual(b);
      }
    }
  });

  it("estimates the server tick from the least-delayed frames", () => {
    const c = new ServerClock();
    c.observe(10, 1000 + 10 * TICK_MS);
    c.observe(11, 1000 + 11 * TICK_MS + 50); // this one ran late
    expect(c.tick(1000 + 12 * TICK_MS)).toBeCloseTo(12, 0);
    expect(c.delay).toBeGreaterThan(2);
    c.observe(12, 1000 + 12 * TICK_MS - 10); // and an early one pulls the estimate forward
    expect(c.tick(1000 + 12 * TICK_MS - 10)).toBeCloseTo(12);
  });

  it("interpolates poses between frames and holds the newest", () => {
    const tl = new Timeline();
    tl.reset(0, [{ x: 0, y: 0, h: 710, tt: 0 }]);
    tl.push(2, [{ x: 10, y: 20, h: 10, tt: 0 }]);
    expect(tl.sample(0, 1)).toEqual({ x: 5, y: 10, h: 720 }); // the short way round past 0
    expect(tl.sample(0, 5)).toEqual({ x: 10, y: 20, h: 10 });
  });
});
