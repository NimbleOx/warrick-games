import { expect, it } from "vitest";
import { newBrain, think, type Brain } from "../../src/shared/ai";
import type { ClientMsg, GameState, ServerMsg } from "../../src/shared/protocol";
import { RoundView } from "../../src/client/view";

// No Node types in this project, so reach process.env the long way round.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const BASE = env.PILL_PANIC_URL ?? "http://localhost:5179/pill-panic";

/**
 * The room closes a page whose build id isn't its own (see the kit's `buildId`). A Vite dev
 * server gives its page the id in /@vite/env, so read it there; set PILL_PANIC_BUILD for a
 * server that isn't one.
 */
async function serverBuild(): Promise<string> {
  if (env.PILL_PANIC_BUILD) return env.PILL_PANIC_BUILD;
  const res = await fetch(`${BASE}/@vite/env`);
  const build = res.ok ? /"__WARRICK_BUILD__":\s*"([^"]+)"/.exec(await res.text())?.[1] : undefined;
  if (!build) throw new Error(`No build id at ${BASE}/@vite/env. Is a dev server there? If not, set PILL_PANIC_BUILD.`);
  return build;
}

/** A headless player: the browser's RoundView, with a CPU brain on the buttons. */
class Bot {
  ws!: WebSocket;
  me = "";
  state: GameState | null = null;
  view: RoundView | null = null;
  key = "";
  skew = 0;
  brain: Brain;
  resyncs = 0;
  fixes = 0;
  /** The furthest our bottle got ahead of the clock. */
  ahead = 0;
  /** Ticks our bottle sat frozen while its round was still on. */
  frozen = 0;
  attacks = 0;
  rounds = new Set<string>();
  private timer = 0 as unknown as ReturnType<typeof setInterval>;
  private waiters: { test: () => boolean; resolve: () => void; reject: (e: Error) => void }[] = [];

  constructor(
    readonly code: string,
    readonly build: string,
    readonly token: string,
    readonly name: string,
    level: "normal" | "hard",
  ) {
    this.brain = newBrain(level, token.length * 77);
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/games/${this.code}/ws`);
    this.ws.addEventListener("message", (ev) => this.onMessage(JSON.parse(String(ev.data)) as ServerMsg));
    // Nothing more will come, so fail whatever is waiting rather than let it time out.
    this.ws.addEventListener("close", (ev) => {
      const error = new Error(`${this.name}'s socket closed: ${ev.code} ${ev.reason}\n${this.describe()}`);
      for (const w of this.waiters.splice(0)) w.reject(error);
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", () => reject(new Error("socket error")));
    });
    this.send({ t: "hello", token: this.token, name: this.name, build: this.build });
    this.timer = setInterval(() => this.tick(), 16);
    await this.until(() => !!this.state);
  }

  send(msg: ClientMsg): boolean {
    if (msg.t === "resync") this.resyncs++;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  close(): void {
    clearInterval(this.timer);
    this.ws.close();
  }

  until(test: () => boolean, ms = 420_000): Promise<void> {
    if (test()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name} timed out waiting: ${test}\n${this.describe()}`)), ms);
      this.waiters.push({
        test,
        resolve: () => (clearTimeout(timer), resolve()),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
    });
  }

  /** Where things stand, for timeouts. */
  describe(): string {
    const v = this.view;
    const r = this.state?.round;
    const bottles = v?.slots().map((s) => {
      const b = v.bottle(s)!;
      return `${s}: tick ${b.tick} ${b.phase} ${b.viruses} germs, ${b.count} capsules`;
    });
    return `phase ${this.state?.phase}, round ${r?.n} (over: ${JSON.stringify(r?.over?.winners ?? null)}), clock ${this.wall()}\n${bottles?.join("\n")}`;
  }

  private wall(): number {
    return this.view?.wall(Date.now() + this.skew) ?? -1;
  }

  private tick(): void {
    const v = this.view;
    if (!v || this.state?.phase !== "playing") return;
    const before = v.own?.e;
    const wall = this.wall();
    v.stepOwn(wall, () => (v.own ? think(v.own.b, this.brain) : 0));
    if (v.own && !v.over) this.ahead = Math.max(this.ahead, v.own.b.tick - Math.max(0, wall));
    const r = this.state?.round;
    if (v.over && r && r.seed === v.seed && !r.over) this.frozen++;
    v.advanceMirrors(1);
    if (v.own && before !== undefined && v.own.e !== before) this.fixes++;
  }

  private onMessage(msg: ServerMsg): void {
    if ("now" in msg) this.skew = msg.now - Date.now();
    if (msg.t === "welcome") {
      this.me = msg.you;
      this.state = msg.state;
      if (msg.snap) this.setView(msg.snap);
    } else if (msg.t === "state") {
      this.state = msg.state;
      this.view?.syncState(msg.state.round);
    } else if (msg.t === "snap") {
      this.setView(msg.snap);
    } else if (msg.t === "f" && this.view) {
      const before = this.view.own?.e;
      this.view.frame(msg);
      if (this.view.own && before !== undefined && this.view.own.e !== before) this.fixes++;
    }
    this.waiters = this.waiters.filter((w) => {
      if (!w.test()) return true;
      w.resolve();
      return false;
    });
  }

  private setView(snap: Parameters<RoundView["applySnap"]>[0]): void {
    const key = `${snap.round}:${snap.lanes[0]?.b.seed}`;
    if (this.view && key === this.key) return this.view.applySnap(snap);
    this.key = key;
    this.rounds.add(key);
    this.view = new RoundView(snap, this.me, {
      send: (m) => this.send(m),
      events: () => {},
      attack: () => this.attacks++,
    });
    this.view.syncState(this.state?.round);
  }
}

it("plays a whole match between two browsers and a CPU without anyone drifting", async () => {
  const res = await fetch(`${BASE}/api/games`, { method: "POST" });
  const { code } = (await res.json()) as { code: string };
  const build = await serverBuild();
  const ann = new Bot(code, build, "live-ann-token-1", "Ann", "hard");
  const bob = new Bot(code, build, "live-bob-token-22", "Bob", "normal");
  await ann.connect();
  await bob.connect();
  ann.send({ t: "settings", settings: { level: 0, speed: "hi", wins: 2, aim: "all" } });
  ann.send({ t: "addCpu", level: "normal" });
  await ann.until(() => (ann.state?.players.length ?? 0) === 3);
  ann.send({ t: "start" });
  await ann.until(() => ann.state?.phase === "results");
  await bob.until(() => bob.state?.phase === "results");

  const r = ann.state!.results!;
  console.log(
    `match over after ${r.rounds} rounds:`,
    r.standings.map((x) => `${x.name} ${x.wins} wins, ${x.cleared} germs, ${x.sent} junk`).join("; "),
    `| attacks seen ${ann.attacks}`,
  );
  expect(r.winnerId).not.toBeNull();
  expect(Math.max(...r.standings.map((x) => x.wins))).toBe(2);
  expect(ann.rounds.size).toBe(r.rounds);
  for (const bot of [ann, bob]) {
    expect(bot.resyncs, `${bot.name} asked to resync`).toBe(0);
    expect(bot.fixes, `${bot.name} was overruled`).toBe(0);
    expect(bot.ahead, `${bot.name} ran ahead of the clock`).toBeLessThanOrEqual(1);
    expect(bot.frozen, `${bot.name}'s bottle froze mid-round`).toBe(0);
  }
  ann.close();
  bob.close();
});
