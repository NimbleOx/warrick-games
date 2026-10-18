import { Battle } from "../src/shared/battle";
import type { ServerMsg } from "../src/shared/protocol";
import { Game, newGameState, type Live } from "../src/worker/game";
import { TANK, type UnitKind } from "../src/shared/constants";
import type { GameMap } from "../src/shared/map";

/**
 * A hand-made map: bases at the given points, joined by the given roads. Every base is a level-1
 * tank depot with an empty garrison unless `kind`/`level`/`garrison` say otherwise.
 */
export function tinyMap(
  points: [number, number][],
  roads: [number, number][],
  extra: { starts?: number[]; kind?: UnitKind[]; level?: number[]; garrison?: number[] } = {},
): GameMap {
  const n = points.length;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of roads) {
    adj[a].push(b);
    adj[b].push(a);
  }
  for (const list of adj) list.sort((a, b) => a - b);
  return {
    id: 1,
    w: Math.max(...points.map((p) => p[0])) + 50,
    h: Math.max(...points.map((p) => p[1])) + 50,
    x: points.map((p) => p[0]),
    y: points.map((p) => p[1]),
    kind: extra.kind ?? new Array<UnitKind>(n).fill(TANK),
    roads,
    adj,
    starts: extra.starts ?? [0, n - 1],
    level: extra.level ?? new Array<number>(n).fill(1),
    garrison: extra.garrison ?? new Array<number>(n).fill(0),
  };
}

/** Four bases in a row, 110 apart (20 tank ticks, 12 helicopter ticks per gap). Slot 0 starts at 0, slot 1 at 3. */
export function lineBattle(garrison = [10, 0, 0, 10]): Battle {
  const map = tinyMap(
    [
      [50, 50],
      [160, 50],
      [270, 50],
      [380, 50],
    ],
    [
      [0, 1],
      [1, 2],
      [2, 3],
    ],
    { garrison },
  );
  return new Battle(map, { slots: [0, 1], countdown: 0, limit: 0 });
}

export function steps(b: Battle, n: number): void {
  for (let i = 0; i < n; i++) b.step();
}

/** A game as the Durable Object runs it: a fresh Game per action, with the live round carried over. */
export function gameSetup() {
  let now = 1_000_000;
  const connected = new Set<string>();
  const s = newGameState("ABCDE", now);
  let live: Live | null = null;
  const sent: ServerMsg[] = [];
  /** Messages to one player. */
  const direct: { pid: string; msg: ServerMsg }[] = [];
  const io = { now: () => now, isConnected: (id: string) => connected.has(id) };
  /** Like the Durable Object: a fresh Game per action, with the live round carried over. */
  const act = <T>(fn: (g: Game) => T): T => {
    const g = new Game(s, io, live);
    const out = fn(g);
    live = g.live;
    sent.push(...g.outbox);
    direct.push(...g.direct);
    return out;
  };
  const human = (name: string) => {
    const p = act((g) => g.addHuman(name));
    connected.add(p.id);
    return p;
  };
  return {
    s,
    act,
    human,
    sent,
    direct,
    connected,
    get live() {
      return live;
    },
    forget() {
      live = null;
    },
    advance(ms: number) {
      now += ms;
    },
    tick(n = 1) {
      for (let i = 0; i < n && s.phase === "playing"; i++) act((g) => g.tick());
    },
  };
}
