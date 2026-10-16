import { describe, expect, it } from "vitest";
import type { Board, Dir } from "../src/shared/board";
import { checkInvariants } from "./ascii";
import { mulberry32, randInt } from "@warrick/kit/shared/rng";
import { Round, applyFrame, viewFromSnapshot, type RoundView } from "../src/shared/sim";

/** Everything a client should agree with the server on, as one string (deep `expect` per tick is too slow). */
function fingerprint(b: Board, kills: number[], deaths: number[], n: number): string {
  const heads = b.heads.map((h) => [h.cell, h.alive ? h.dir : 0, h.alive, h.fresh, h.respawnAt]);
  return JSON.stringify([b.owner.join(""), b.trail.join(""), [...b.land], heads, kills, deaths, n]);
}

function expectSameBoard(view: RoundView, round: Round): void {
  const mine = fingerprint(view.board, view.kills, view.deaths, view.n);
  const theirs = fingerprint(round.board, round.kills, round.deaths, round.n);
  if (mine !== theirs) expect(mine).toBe(theirs);
}

describe("replaying frames", () => {
  it("keeps a client's board identical to the server's through a chaotic game", () => {
    const rng = mulberry32(99);
    const round = new Round(rng, { w: 60, h: 40, slots: [0, 1, 2, 3, 4, 5], ticks: 1500, countdown: 10 });
    const wire = <T>(x: T): T => JSON.parse(JSON.stringify(x));
    let view = viewFromSnapshot(wire(round.snapshot()))!;
    let claims = 0;
    let kills = 0;

    while (!round.over) {
      for (let s = 0; s < 8; s++) {
        if (rng() < 0.2) round.turn(s, randInt(rng, 0, 3) as Dir);
      }
      if (round.n === 400) round.join(6);
      if (round.n === 700) round.leave(2);
      if (round.n === 900) round.join(2);

      const frame = wire(round.step());
      expect(applyFrame(view, frame)).toBe(true);
      expectSameBoard(view, round);
      if (frame.ck !== undefined) expect(view.board.checksum()).toBe(frame.ck);
      claims += frame.o.filter((o) => o[0] === "c").length;
      kills += frame.o.filter((o) => o[0] === "d" && o[4] === "trail").length;

      if (round.n % 50 === 0) checkInvariants(round.board);
      if (round.n % 250 === 0) {
        // A reconnecting client starts again from a snapshot.
        view = viewFromSnapshot(wire(round.snapshot()))!;
        expectSameBoard(view, round);
      }
    }
    // The random walkers should have exercised the interesting paths.
    expect(claims).toBeGreaterThan(50);
    expect(kills).toBeGreaterThan(3);
  });

  it("refuses a frame that skips a tick", () => {
    const round = new Round(mulberry32(1), { w: 30, h: 20, slots: [0, 1], ticks: 50 });
    const view = viewFromSnapshot(round.snapshot())!;
    round.step();
    expect(applyFrame(view, round.step())).toBe(false);
    expect(view.n).toBe(0);
  });
});
