// The client's queue of server events: how fast each one plays, how it catches up when events pile
// up, and, with the real room and a Fast CPU, that your turn is yours as soon as it reaches you.
import { type FakeSocket, type Json, openRoom } from "@warrick/kit/testing/room";
import { mulberry32 } from "@warrick/kit/shared/rng";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventQueue, SNAP_BACKLOG, playMs, type Anim, type Item } from "../src/client/queue";
import { cpuNext } from "../src/shared/ai";
import { CPU_FAST_MS } from "../src/shared/constants";
import { MAPS } from "../src/shared/maps";
import type { GameState, TurnEvent } from "../src/shared/protocol";
import type { ActEvent } from "../src/shared/rules";
import { GameRoom } from "../src/worker/room";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

/** A client's queue, and what it did: each event played (and how long for), its effects, the states and turns. */
function client(seat: () => number, canPlay = () => true, onApply = (_s: GameState) => {}) {
  const log: string[] = [];
  const played: { a: Anim; full: number }[] = [];
  const shown: GameState[] = [];
  const q = new EventQueue({
    seat,
    canPlay,
    apply: (s) => {
      shown.push(s);
      onApply(s);
    },
    turn: (ev) => log.push(`turn ${ev.seat}`),
    started: (a) => {
      const full = playMs(a.item, a.item.kind === "act" && a.item.ev.seat === seat());
      played.push({ a, full: full.moveMs + full.actionMs });
      log.push(`play ${Math.round(a.moveMs + a.actionMs)}`);
    },
    fire: (_a, quiet) => log.push(quiet ? "quiet" : "fire"),
  });
  return { q, log, played, shown };
}

describe("the event queue", () => {
  // Just what the queue reads from a state: the settings, the players and the seat order.
  const state = (fastCpus = false) =>
    ({
      settings: { fastCpus },
      order: ["me", "cpu"],
      players: [
        { id: "me", seat: 0, cpu: null },
        { id: "cpu", seat: 1, cpu: "hard" },
      ],
    }) as unknown as GameState;
  /** The CPU (seat 1) moves `tiles` and waits (390 ms at full speed for 3 tiles), or attacks. */
  const act = (tiles = 3, action: ActEvent["action"] = "wait", fast = false): Item => ({
    kind: "act",
    ev: { seat: 1, unit: 1, type: "infantry", path: Array.from({ length: tiles + 1 }, (_, i) => i), action },
    state: state(fast),
  });
  const turn = (seat: number): Item => ({ kind: "turn", ev: { seat } as TurnEvent, state: state() });

  it("plays an event at full speed when nothing waits behind it", () => {
    const { q, log, shown } = client(() => 0);
    q.push(act(3));
    expect(log).toEqual(["play 390"]);
    vi.advanceTimersByTime(389);
    expect(shown).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(shown).toHaveLength(1);
    expect(log).toEqual(["play 390", "fire"]);
    expect(q.busy).toBe(false);
  });

  it("hurries when events wait, and never keeps more than a couple waiting", () => {
    const { q, log, shown } = client(() => 0);
    q.push(act(3, "attack"));
    q.push(act(3));
    q.push(act(3));
    // Two waiting: the attack still plays at full speed.
    expect(log).toEqual(["play 1170"]);
    // A third: the attack is finished at once (its effects, without sounds), and the next plays at 0.3×.
    q.push(act(3));
    expect(log).toEqual(["play 1170", "quiet", "play 117"]);
    expect(shown).toHaveLength(1);
    expect(q.backlog()).toBe(SNAP_BACKLOG - 1);
    vi.advanceTimersByTime(117);
    // Then 0.6× with one waiting, and full speed for the last.
    expect(log.slice(3)).toEqual(["fire", "play 234"]);
    vi.advanceTimersByTime(234 + 390);
    expect(log.slice(5)).toEqual(["fire", "play 390", "fire"]);
    expect(shown).toHaveLength(4);
  });

  it("applies a burst at once, but for the last few", () => {
    const { q, log, shown } = client(() => 0);
    for (let i = 0; i < 8; i++) q.push(act(3));
    expect(shown).toHaveLength(5);
    expect(log.filter((l) => l === "quiet")).toHaveLength(5);
    expect(q.backlog()).toBe(SNAP_BACKLOG - 1);
  });

  it("starts your turn at once, applying whatever is ahead of it", () => {
    const { q, log, shown } = client(() => 0);
    q.push(act(7, "attack"));
    q.push(act(3));
    q.push(turn(0));
    expect(q.busy).toBe(false);
    expect(shown).toHaveLength(3);
    expect(log).toEqual(["play 1530", "quiet", "quiet", "turn 0"]);
  });

  it("lets someone else's turn wait its turn", () => {
    const { q, log } = client(() => 0);
    q.push(act(3));
    q.push(turn(1));
    expect(q.busy).toBe(true);
    vi.advanceTimersByTime(390);
    expect(log).toEqual(["play 390", "fire", "turn 1"]);
    expect(q.busy).toBe(false);
  });

  it("plays a Fast CPU's step within the gap before its next one", () => {
    const { q, log } = client(() => 0);
    q.push(act(7, "attack", true));
    q.push(act(1, "wait", true));
    expect(log).toEqual([`play ${CPU_FAST_MS}`]);
    vi.advanceTimersByTime(CPU_FAST_MS);
    expect(log).toEqual([`play ${CPU_FAST_MS}`, "fire", `play ${CPU_FAST_MS}`]);
  });

  it("just applies events in a hidden tab", () => {
    const { q, log, shown } = client(
      () => 0,
      () => false,
    );
    q.push(act(3, "attack"));
    q.push(turn(1));
    expect(shown).toHaveLength(2);
    expect(log).toEqual(["turn 1"]);
    expect(q.busy).toBe(false);
  });
});

/** The simulation looks at Ann's screen every STEP ms. */
const STEP = 5;

/**
 * Ann against a hard CPU on Twin Rivers: the real room, and Ann's queue on the same (fake) clock,
 * each message reaching her 30 ms plus up to `jitter` ms after the room sends it. Ann plays like
 * the autoplay dev aid, a CPU's move for her as soon as her screen lets her act, for `days` days
 * or until someone wins. Returns how long each of her turns waited on her screen after it reached
 * her, how long each CPU step took to be on her screen after it reached her, and what her queue did.
 */
async function vsCpu({
  fastCpus,
  days,
  jitter = 150,
  seed = 1,
}: {
  fastCpus: boolean;
  days: number;
  jitter?: number;
  seed?: number;
}) {
  const r = await openRoom(GameRoom);
  const ann: FakeSocket = await r.connect("Ann");
  await r.say(ann, { t: "settings", settings: { map: "twin-rivers", fastCpus } });
  await r.say(ann, { t: "addCpu", level: "hard" });

  /** When each of Ann's turns and CPU steps reached her, and how long they took to be on her screen. */
  const turnsAt: number[] = [];
  const waits: number[] = [];
  const steps = new Map<GameState, number>();
  const lags: number[] = [];
  let shown = null as GameState | null;
  const seat = () => shown?.players.find((p) => p.id === ann.you)?.seat ?? -1;
  const myTurn = () => !!shown && shown.phase === "playing" && !shown.winnerId && shown.order[shown.turn] === ann.you;
  const c = client(seat, undefined, (s) => {
    shown = s;
    const at = steps.get(s);
    if (at !== undefined) lags.push(Date.now() - at);
  });

  let pending = false;
  const net = mulberry32(seed);
  let lastAt = 0;
  ann.onSend = (msg: Json) => {
    // In order, so a late message holds up the ones behind it.
    lastAt = Math.max(lastAt, Date.now() + 30 + net() * jitter);
    setTimeout(() => {
      // An answer to her last action, or something newer.
      pending = false;
      const m = msg as { t: string; ev?: { seat: number }; state?: GameState };
      if (m.t === "act" || m.t === "build" || m.t === "turn") {
        const item = { kind: m.t, ev: m.ev, state: m.state } as Item;
        if (m.t === "turn" && m.ev!.seat === seat()) turnsAt.push(Date.now());
        else if (m.t !== "turn" && m.ev!.seat !== seat()) steps.set(m.state!, Date.now());
        c.q.push(item);
      } else if (m.t === "state" && m.state) {
        if (c.q.busy) c.q.push({ kind: "state", state: m.state });
        else shown = m.state;
      }
    }, lastAt - Date.now());
  };
  await r.say(ann, { t: "start" });

  const rng = mulberry32(seed);
  for (let t = 0; t < 600_000; t += STEP) {
    vi.advanceTimersByTime(STEP);
    const alarm = r.storage.alarm();
    if (alarm !== null && alarm <= Date.now()) await r.room.alarm();
    const s = shown;
    if (s?.winnerId || (s?.day ?? 0) > days) break;
    if (!s || !myTurn() || c.q.busy || pending) continue;
    while (turnsAt.length > waits.length) waits.push(Date.now() - turnsAt[waits.length]);
    const mv = cpuNext("hard", MAPS[s.mapId!], s.board!, seat(), rng, s.day);
    pending = true;
    if (mv.kind === "act") await r.say(ann, { t: "act", ...mv.act });
    else if (mv.kind === "build") await r.say(ann, { t: "build", at: mv.at, unit: mv.unit });
    else await r.say(ann, { t: "end" });
  }
  return { waits, lags, played: c.played, log: c.log };
}

describe("against a CPU, with messages arriving 30–180 ms after they're sent", () => {
  it("with Fast CPUs, your turn is yours as soon as it reaches you, and the CPU's steps keep up", async () => {
    const { waits, lags, log } = await vsCpu({ fastCpus: true, days: 12 });
    // Before the queue caught up, her turn waited a median 1.2 s here, and up to 2.8 s.
    expect(waits.length).toBeGreaterThanOrEqual(10);
    expect(Math.max(...waits)).toBeLessThanOrEqual(STEP);
    // A step plays within CPU_FAST_MS, and no more than two wait behind the one playing.
    expect(lags.length).toBeGreaterThan(50);
    expect(Math.max(...lags)).toBeLessThanOrEqual(3 * CPU_FAST_MS);
    expect(log).toContain("fire");
  });

  it("at normal speed, every event plays at full length", async () => {
    const { waits, played, log } = await vsCpu({ fastCpus: false, days: 6 });
    expect(waits.length).toBeGreaterThanOrEqual(5);
    expect(Math.max(...waits)).toBeLessThanOrEqual(STEP);
    expect(played.length).toBeGreaterThan(30);
    for (const { a, full } of played) expect(a.moveMs + a.actionMs).toBe(full);
    expect(log).not.toContain("quiet");
  });
});
