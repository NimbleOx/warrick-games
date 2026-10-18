import { describe, expect, it } from "vitest";
import {
  BLUE,
  B_CW,
  B_DOWN,
  B_DROP,
  B_LEFT,
  B_RIGHT,
  Bottle,
  COLOR,
  KIND,
  LINK_D,
  LINK_L,
  LINK_R,
  LINK_U,
  LONE,
  RED,
  VIRUS,
  YELLOW,
  capsuleAt,
  virusLayout,
  type BottleEvent,
  type Piece,
} from "../src/shared/bottle";
import { COLS, GRAVITY, ROWS, START_SPEED, virusCount, virusTop } from "../src/shared/constants";
import { mulberry32 } from "@warrick/kit/shared/rng";

/** Build a bottle from rows of text, bottom row last. r/y/b are viruses, R/Y/B loose halves, . empty. */
function bottleFrom(rows: string[]): Bottle {
  const cells = new Uint8Array(COLS * ROWS);
  const top = ROWS - rows.length;
  rows.forEach((row, i) => {
    [...row].forEach((ch, x) => {
      const c = ({ r: RED, y: YELLOW, b: BLUE } as Record<string, number>)[ch.toLowerCase()];
      if (c) cells[(top + i) * COLS + x] = (ch === ch.toLowerCase() ? VIRUS : LONE) | c;
    });
  });
  return new Bottle(1234, START_SPEED.med, cells);
}

/** Step until a capsule is falling, then swap it for the one given. */
function withPiece(b: Bottle, piece: Partial<Piece>): Bottle {
  for (let i = 0; i < 100 && b.phase !== "fall"; i++) b.step(0);
  Object.assign(b.piece!, piece);
  b.events = [];
  return b;
}

/** Step until the bottle waits for its next capsule (or is done), collecting events. */
function settle(b: Bottle): BottleEvent[] {
  const events: BottleEvent[] = [...b.events];
  b.events = [];
  for (let i = 0; i < 2000; i++) {
    if (b.phase === "spawn" || b.done) return events;
    b.step(0);
    events.push(...b.events);
    b.events = [];
  }
  throw new Error("never settled");
}

function grid(b: Bottle): string[] {
  const out: string[] = [];
  for (let y = 0; y < ROWS; y++) {
    let row = "";
    for (let x = 0; x < COLS; x++) {
      const c = b.at(x, y);
      const ch = ".RYB"[c & COLOR];
      row += (c & KIND) === VIRUS ? ch.toLowerCase() : ch;
    }
    out.push(row);
  }
  return out;
}

describe("viruses", () => {
  it("places (level + 1) × 4, low in the bottle, never three in a row", () => {
    for (const level of [0, 5, 10, 15, 20]) {
      for (let seed = 1; seed <= 20; seed++) {
        const cells = virusLayout(seed * 7919, level);
        let n = 0;
        for (let y = 0; y < ROWS; y++) {
          for (let x = 0; x < COLS; x++) {
            const c = cells[y * COLS + x];
            if (!c) continue;
            n++;
            expect(c & KIND).toBe(VIRUS);
            expect(y).toBeGreaterThanOrEqual(virusTop(level));
            const same = (dx: number, dy: number) => (cells[(y + dy) * COLS + x + dx] & COLOR) === (c & COLOR);
            if (x + 2 < COLS) expect(same(1, 0) && same(2, 0)).toBe(false);
            if (y + 2 < ROWS) expect(same(0, 1) && same(0, 2)).toBe(false);
          }
        }
        expect(n).toBe(virusCount(level));
      }
    }
  });

  it("is the same for the same seed", () => {
    expect(virusLayout(42, 8)).toEqual(virusLayout(42, 8));
    expect(virusLayout(42, 8)).not.toEqual(virusLayout(43, 8));
  });
});

describe("capsules", () => {
  it("hands everyone the same sequence, in all nine color pairs", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const [a, b] = capsuleAt(99, i);
      expect([1, 2, 3]).toContain(a);
      expect([1, 2, 3]).toContain(b);
      expect(capsuleAt(99, i)).toEqual([a, b]);
      seen.add(`${a}${b}`);
    }
    expect(seen.size).toBe(9);
  });

  it("appears lying across the middle columns and falls with gravity", () => {
    const b = bottleFrom(["r......."]);
    b.step(0);
    expect(b.phase).toBe("fall");
    expect(b.piece).toMatchObject({ x: 3, y: 0, rot: 0 });
    for (let i = 0; i < GRAVITY[START_SPEED.med]; i++) b.step(0);
    expect(b.piece!.y).toBe(1);
  });

  it("moves, auto-repeats when held, and stops at the wall", () => {
    const b = withPiece(bottleFrom(["r......."]), {});
    b.step(B_LEFT);
    expect(b.piece!.x).toBe(2);
    for (let i = 0; i < 30; i++) b.step(B_LEFT);
    expect(b.piece!.x).toBe(0);
    b.step(0);
    b.step(B_RIGHT);
    expect(b.piece!.x).toBe(1);
  });

  it("stands up around its left half, and kicks off the right wall when laid down", () => {
    const b = withPiece(bottleFrom(["r......."]), { a: RED, b: BLUE, y: 5 });
    b.step(B_CW);
    expect(b.piece).toMatchObject({ x: 3, y: 5, rot: 1 });
    b.step(0);
    for (let i = 0; i < 40; i++) b.step(B_RIGHT);
    expect(b.piece!.x).toBe(7);
    b.step(0);
    b.step(B_CW);
    expect(b.piece).toMatchObject({ x: 6, rot: 2 });
  });

  it("hard-drops and locks with linked halves", () => {
    const b = withPiece(bottleFrom(["r......."]), { a: RED, b: YELLOW });
    b.step(B_DROP);
    expect(b.at(3, ROWS - 1)).toBe(LINK_R | RED);
    expect(b.at(4, ROWS - 1)).toBe(LINK_L | YELLOW);
    const c = withPiece(bottleFrom(["r......."]), { a: RED, b: YELLOW, rot: 1, y: 3 });
    c.step(B_DROP);
    expect(c.at(3, ROWS - 2)).toBe(LINK_D | RED);
    expect(c.at(3, ROWS - 1)).toBe(LINK_U | YELLOW);
  });

  it("doesn't soft-drop a new capsule while down is still held from the last one", () => {
    const b = bottleFrom(["r......."]);
    b.step(B_DOWN);
    expect(b.phase).toBe("fall");
    for (let i = 0; i < 6; i++) b.step(B_DOWN);
    expect(b.piece!.y).toBe(0);
    b.step(0);
    for (let i = 0; i < 6; i++) b.step(B_DOWN);
    expect(b.piece!.y).toBe(3);
  });
});

describe("clearing", () => {
  it("clears four in a column, viruses included, and wins when the last virus goes", () => {
    const b = withPiece(bottleFrom(["...r....", "...r...."]), { a: RED, b: RED, rot: 1, y: 1 });
    expect(b.viruses).toBe(2);
    b.step(B_DROP);
    expect(b.phase).toBe("pop");
    settle(b);
    expect(b.phase).toBe("won");
    expect(b.viruses).toBe(0);
    expect(b.cleared).toBe(2);
  });

  it("lets loose halves fall after a clear, chains, and attacks with the colors of the lines", () => {
    // The capsule's red completes the row of reds. Once they pop, the yellow half falls onto the
    // three yellow viruses, and the capsule's other half drops onto the blues beside it.
    const b = withPiece(
      bottleFrom([
        "Y.......", //
        "RRR.....",
        "ybbb....",
        "ybbb....",
        "ybbb....",
      ]),
      { x: 3, y: 0, rot: 1, a: RED, b: RED },
    );
    b.step(B_DROP);
    const events = settle(b);
    expect(grid(b).slice(-5)).toEqual(["........", "...R....", ".bbb....", ".bbb....", ".bbb...."]);
    expect(b.bestChain).toBe(2);
    expect(b.viruses).toBe(9);
    expect(events.filter((e) => e.k === "attack")).toEqual([{ k: "attack", colors: [RED, YELLOW] }]);
  });

  it("attacks when one capsule finishes two lines at once", () => {
    const b = withPiece(bottleFrom(["rrr..yyy"]), { x: 3, a: RED, b: YELLOW });
    b.step(B_DROP);
    const events = settle(b);
    expect(events.filter((e) => e.k === "attack")).toEqual([{ k: "attack", colors: [RED, YELLOW] }]);
    expect(b.phase).toBe("won");
  });

  it("scores each germ in a combo twice the last, by speed, and keeps the score in snapshots", () => {
    // Medium speed: 200 a germ, then 400.
    const two = withPiece(bottleFrom(["...r....", "...r...."]), { a: RED, b: RED, rot: 1, y: 1 });
    two.step(B_DROP);
    settle(two);
    expect(two.score).toBe(200 + 400);
    // Six germs in one capsule's combo.
    const six = withPiece(bottleFrom(["rrr..yyy"]), { x: 3, a: RED, b: YELLOW });
    six.step(B_DROP);
    settle(six);
    expect(six.score).toBe(200 + 400 + 800 + 1600 + 3200 + 6400);
    // A chain counts on from the clears before it: three germs after a clear with none.
    const chain = withPiece(bottleFrom(["Y.......", "RRR.....", "ybbb....", "ybbb....", "ybbb...."]), {
      x: 3,
      y: 0,
      rot: 1,
      a: RED,
      b: RED,
    });
    chain.step(B_DROP);
    settle(chain);
    expect(chain.score).toBe(200 + 400 + 800);
    expect(Bottle.restore(chain.snapshot()).score).toBe(chain.score);
    // Low speed is worth 100 a germ, high 300.
    for (const [start, base] of [
      [START_SPEED.low, 100],
      [START_SPEED.hi, 300],
    ]) {
      const cells = bottleFrom(["...r....", "...r...."]).cells;
      const b = withPiece(new Bottle(1234, start, cells), { a: RED, b: RED, rot: 1, y: 1 });
      b.step(B_DROP);
      settle(b);
      expect(b.score).toBe(base * 3);
    }
  });

  it("doesn't attack for a single line", () => {
    const b = withPiece(bottleFrom(["rrr....b"]), { x: 3, a: RED, b: YELLOW });
    b.step(B_DROP);
    expect(settle(b).some((e) => e.k === "attack")).toBe(false);
  });
});

describe("garbage", () => {
  it("drops after the next capsule lands, and lands like loose halves", () => {
    const b = withPiece(bottleFrom(["......b."]), { a: RED, b: YELLOW });
    b.addGarbage({
      id: 1,
      p: [
        [0, BLUE],
        [4, RED],
      ],
    });
    b.step(B_DROP);
    const events = settle(b);
    expect(events).toContainEqual({ k: "garbage", n: 2 });
    expect(b.pending).toHaveLength(0);
    expect(grid(b).slice(-2)).toEqual(["....R...", "B..RY.b."]);
  });

  it("doesn't attack back when garbage completes lines", () => {
    const b = withPiece(bottleFrom(["......b.", "rrr.yyy."]), { x: 0, y: 0, a: BLUE, b: BLUE });
    // The second attack drops in the row below the first, so it lands first.
    b.addGarbage({
      id: 1,
      p: [
        [3, BLUE],
        [7, BLUE],
      ],
    });
    b.addGarbage({
      id: 2,
      p: [
        [3, RED],
        [7, YELLOW],
      ],
    });
    b.step(B_DROP);
    const events = settle(b);
    expect(events.filter((e) => e.k === "pop").length).toBeGreaterThan(0);
    expect(events.some((e) => e.k === "attack")).toBe(false);
  });
});

describe("determinism", () => {
  it("restores from a snapshot and carries on identically", () => {
    const rng = mulberry32(7);
    const a = Bottle.create(555, 10, START_SPEED.hi);
    const masks = Array.from({ length: 3000 }, () => {
      const r = rng();
      return r < 0.7 ? 0 : [B_LEFT, B_RIGHT, B_CW, B_DOWN, B_DROP][Math.floor(rng() * 5)];
    });
    for (let i = 0; i < 1000; i++) a.step(masks[i]);
    const b = Bottle.restore(JSON.parse(JSON.stringify(a.snapshot())));
    expect(b.checksum()).toBe(a.checksum());
    for (let i = 1000; i < 3000; i++) {
      if (i === 1500) {
        a.addGarbage({
          id: 1,
          p: [
            [1, RED],
            [5, BLUE],
          ],
        });
        b.addGarbage({
          id: 1,
          p: [
            [1, RED],
            [5, BLUE],
          ],
        });
      }
      a.step(masks[i]);
      b.step(masks[i]);
    }
    expect(b.checksum()).toBe(a.checksum());
    expect(b.snapshot()).toEqual(a.snapshot());
  });

  it("tops out when the top middle is blocked", () => {
    const b = bottleFrom(["r......."]);
    b.cells[3] = LONE | RED;
    b.step(0);
    expect(b.phase).toBe("dead");
  });

  it("tops out when a capsule lands sticking out of the top", () => {
    const b = bottleFrom(["r......."]);
    for (let y = 1; y < ROWS; y++) b.cells[y * COLS + 5] = LONE | ((y % 3) + 1);
    withPiece(b, { x: 5, y: 0, rot: 1, a: RED, b: RED });
    b.step(B_DROP);
    expect(b.phase).toBe("dead");
    expect(b.at(5, 0)).toBe(0);
  });
});
