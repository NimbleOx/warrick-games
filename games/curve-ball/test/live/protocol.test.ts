import { expect, it } from "vitest";
import type { ClientMsg, FrameMsg, GameState, RoundSnapshot, ServerMsg } from "../../src/shared/protocol";
import { Round } from "../../src/shared/sim";

// No Node types in this project, so reach process.env the long way round.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const BASE = env.CURVE_BALL_URL ?? "http://localhost:5175/curve-ball";

/** A headless player that rebuilds rounds from snapshots and frames, exactly like the browser does. */
class Bot {
  ws!: WebSocket;
  me = "";
  state: GameState | null = null;
  round: Round | null = null;
  roundNum = 0;
  frames = 0;
  snapshots = 0;
  checksums = 0;
  mismatches: string[] = [];
  bytes = 0;
  /** When each frame arrived. */
  arrivals: number[] = [];
  echoed: [number, number][] = [];
  private waiters: { test: () => boolean; resolve: () => void }[] = [];

  constructor(
    readonly code: string,
    readonly token: string,
    readonly name: string,
  ) {}

  async connect(): Promise<void> {
    this.ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/games/${this.code}/ws`);
    this.ws.addEventListener("message", (ev) => this.onMessage(JSON.parse(String(ev.data)) as ServerMsg, String(ev.data).length));
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", () => reject(new Error("socket error")));
    });
    this.send({ t: "hello", token: this.token, name: this.name });
    await this.until(() => !!this.state);
  }

  send(msg: ClientMsg): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.close();
    this.state = null;
  }

  until(test: () => boolean, ms = 30_000): Promise<void> {
    if (test()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting: ${test}`)), ms);
      this.waiters.push({
        test,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  private onMessage(msg: ServerMsg, size: number): void {
    if (msg.t === "welcome") {
      this.me = msg.you;
      this.state = msg.state;
      this.setRound(msg.round);
    } else if (msg.t === "state") {
      this.state = msg.state;
    } else if (msg.t === "round") {
      this.setRound(msg.round);
    } else if (msg.t === "f") {
      this.bytes += size;
      this.onFrame(msg);
    }
    this.waiters = this.waiters.filter((w) => {
      if (!w.test()) return true;
      w.resolve();
      return false;
    });
  }

  private setRound(snap: RoundSnapshot | null): void {
    if (!snap) return;
    this.snapshots++;
    this.round = Round.replay(snap, snap.inputs, snap.tick);
    this.roundNum = snap.num;
  }

  private onFrame(f: FrameMsg): void {
    const r = this.round;
    if (!r) return;
    if (f.n !== r.tick) {
      this.mismatches.push(`round ${this.roundNum}: frame ${f.n} but client is at tick ${r.tick}`);
      return;
    }
    this.arrivals.push(performance.now());
    this.frames++;
    const mine = r.index(this.me);
    for (const [slot, s] of f.i ?? []) {
      r.setSteer(slot, s);
      if (slot === mine) this.echoed.push([f.n, s]);
    }
    const deaths = r.step().map((d) => d.slot);
    if (deaths.join() !== (f.d ?? []).join()) this.mismatches.push(`tick ${f.n}: deaths ${deaths} vs ${f.d}`);
    if (f.c !== undefined) {
      this.checksums++;
      if (f.c !== r.checksum()) this.mismatches.push(`tick ${f.n}: checksum ${r.checksum()} vs ${f.c}`);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

it("plays a round over the network, and every client agrees with the server", async () => {
  const res = await fetch(`${BASE}/api/games`, { method: "POST" });
  expect(res.status).toBe(200);
  const { code } = (await res.json()) as { code: string };

  const host = new Bot(code, `host-${crypto.randomUUID()}`, "Host");
  await host.connect();
  expect(host.state!.phase).toBe("lobby");
  host.send({ t: "addCpu", level: "hard" });
  host.send({ t: "addCpu", level: "normal" });
  host.send({ t: "addCpu", level: "easy" });
  await host.until(() => host.state!.players.length === 4);
  host.send({ t: "start" });
  await host.until(() => host.state!.phase === "countdown");
  expect(host.round!.heads).toHaveLength(4);

  // Steering during the countdown is held for tick 0.
  host.send({ t: "steer", s: -1 });
  await host.until(() => host.state!.phase === "playing");
  await host.until(() => host.frames > 5);
  expect(host.echoed[0]).toEqual([0, -1]);
  host.send({ t: "steer", s: 1 });
  await host.until(() => host.echoed.length >= 2, 2000);
  expect(host.echoed[1][1]).toBe(1);
  host.send({ t: "steer", s: 0 });

  // Someone joins mid-round: they watch, rebuilding the round from a snapshot.
  const late = new Bot(code, `late-${crypto.randomUUID()}`, "Late");
  await late.connect();
  expect(late.state!.players.find((p) => p.id === late.me)!.spectator).toBe(true);
  await late.until(() => late.frames > 30);

  // A client that asks for a resync gets a fresh snapshot and carries on from it.
  const before = late.snapshots;
  late.send({ t: "resync" });
  await late.until(() => late.snapshots > before, 2000);
  const after = late.frames;
  await late.until(() => late.frames > after + 10);

  // The host reloads: same token, same seat, round rebuilt from a fresh snapshot.
  const seat = host.me;
  host.close();
  await sleep(300);
  const back = new Bot(code, host.token, "Host");
  await back.connect();
  expect(back.me).toBe(seat);
  await back.until(() => back.frames > 30);

  // Cadence: about 30 frames a second while a human is still riding (the host, early in the round).
  const t = host.arrivals;
  const fps = 30 / ((t[30] - t[0]) / 1000);
  expect(fps).toBeGreaterThan(25);
  expect(fps).toBeLessThan(35);
  await sleep(2000);

  for (const bot of [host, late, back]) {
    expect(bot.mismatches).toEqual([]);
    expect(bot.checksums).toBeGreaterThan(0);
  }
  console.log(
    `frames: ${late.frames} at ${fps.toFixed(1)}/s, ${(late.bytes / late.frames).toFixed(1)} bytes each; checksums ok: ${late.checksums + back.checksums + host.checksums}`,
  );
  back.send({ t: "leave" });
  late.close();
});
