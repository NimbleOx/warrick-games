import { describe, expect, it } from "vitest";
import { mulberry32 } from "@warrick/kit/shared/rng";
import { cpuNext } from "../src/shared/ai";
import { MAP_LIST, MAPS } from "../src/shared/maps";
import { applyAct, unitTile } from "../src/shared/rules";
import { at, boardWith, testMap } from "./helpers";
import { simulate } from "./sim";

const LEVELS = ["easy", "normal", "hard"] as const;

describe("CPU players", () => {
  // Every step a CPU takes goes through the same checks as a human's (see sim.ts).
  for (const m of MAP_LIST) {
    it(`only make legal moves on ${m.name}, at every level`, () => {
      for (const level of LEVELS) {
        const r = simulate(m, Array(m.players).fill(level), 11, m.players > 2 ? 25 : 40);
        expect(r.problems, `${level}`).toEqual([]);
        expect(r.steps).toBeGreaterThan(50);
      }
    });
  }

  it("finish two-player games", () => {
    for (const id of ["pocket-duel", "twin-rivers", "mirror-lake"]) {
      for (const level of LEVELS) {
        // Equal CPUs can occasionally stall; most games must end.
        const won = [1, 2, 3].filter((seed) => simulate(MAPS[id], [level, level], seed, 100).winner !== null);
        expect(won.length, `${id} ${level}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("finish a four-player game", () => {
    const r = simulate(MAPS["four-corners"], ["easy", "normal", "hard", "normal"], 5, 120);
    expect(r.problems).toEqual([]);
    expect(r.winner).not.toBeNull();
  });

  it("get stronger by level", () => {
    let hardWins = 0;
    let normalWins = 0;
    for (let seed = 1; seed <= 6; seed++) {
      // Each side takes each seat, so moving first doesn't decide it.
      const seats = seed % 2 ? (["hard", "easy"] as const) : (["easy", "hard"] as const);
      const r = simulate(MAPS["twin-rivers"], [...seats], seed, 60);
      if (r.winner !== null && seats[r.winner] === "hard") hardWins++;
      const seats2 = seed % 2 ? (["normal", "easy"] as const) : (["easy", "normal"] as const);
      const r2 = simulate(MAPS["pocket-duel"], [...seats2], seed, 60);
      if (r2.winner !== null && seats2[r2.winner] === "normal") normalWins++;
    }
    expect(hardWins).toBeGreaterThanOrEqual(5);
    expect(normalWins).toBeGreaterThanOrEqual(5);
  });

  describe("tactics", () => {
    const M = testMap(["H1. . . . . . . ", ". . . . . . . . ", ". . . . . C-. . ", ". . . . . . . . ", "F1. . . . . F2H2"]);

    it("attack what they can reach", () => {
      for (const level of LEVELS) {
        const b = boardWith(M, [
          ["tank", 0, 1, 1],
          ["infantry", 1, 4, 1],
        ]);
        const mv = cpuNext(level, M, b, 0, mulberry32(1));
        expect(mv, level).toMatchObject({ kind: "act", act: { action: "attack", target: 2 } });
      }
    });

    it("send infantry to capture", () => {
      for (const level of LEVELS) {
        const b = boardWith(M, [["infantry", 0, 4, 2]]);
        const mv = cpuNext(level, M, b, 0, mulberry32(2));
        expect(mv, level).toMatchObject({ kind: "act", act: { action: "capture", to: at(M, 5, 2) } });
      }
    });

    it("finish off a damaged unit before chipping at a healthy one (hard)", () => {
      const b = boardWith(M, [
        ["tank", 0, 3, 1],
        ["tank", 1, 3, 0, 2],
        ["tank", 1, 4, 1],
      ]);
      const mv = cpuNext("hard", M, b, 0, mulberry32(3));
      expect(mv).toMatchObject({ kind: "act", act: { action: "attack", target: 2 } });
    });

    it("don't take losing trades (normal and hard)", () => {
      for (const level of ["normal", "hard"] as const) {
        // Infantry against a heavy tank: it would do nothing and get wiped out.
        const b = boardWith(M, [
          ["infantry", 0, 3, 1],
          ["heavy", 1, 5, 1],
        ]);
        const mv = cpuNext(level, M, b, 0, mulberry32(4));
        expect(mv.kind === "act" && mv.act.action === "attack", level).toBe(false);
      }
    });

    it("keep artillery out of reach of direct fire (normal)", () => {
      const b = boardWith(M, [
        ["artillery", 0, 2, 2],
        ["tank", 1, 7, 2],
      ]);
      const mv = cpuNext("normal", M, b, 0, mulberry32(5));
      if (mv.kind === "act") {
        const after = applyAct(M, b, 0, mv.act);
        const art = b.units.find((u) => u.id === after.unit)!;
        // The tank moves 6 and hits next door: the artillery must be 8 or more tiles away.
        const d = Math.abs(art.x - 7) + Math.abs(art.y - 2);
        expect(d).toBeGreaterThanOrEqual(8);
      }
    });

    it("go for an enemy capturer on their HQ first (hard)", () => {
      const b = boardWith(M, [
        ["tank", 0, 3, 1],
        ["infantry", 1, 0, 1],
        ["tank", 1, 5, 1, 3],
      ]);
      b.capture[M.hq[0]] = 10;
      b.units[1].x = 0;
      b.units[1].y = 0;
      const mv = cpuNext("hard", M, b, 0, mulberry32(6));
      expect(mv).toMatchObject({ kind: "act", act: { action: "attack", target: 2 } });
      expect(unitTile(M, b.units[1])).toBe(at(M, 0, 0));
    });

    it("build, then end the turn", () => {
      for (const level of LEVELS) {
        const b = boardWith(M, [], [5000, 0]);
        const mv = cpuNext(level, M, b, 0, mulberry32(7), 3);
        expect(mv, level).toMatchObject({ kind: "build", at: at(M, 0, 4) });
        const none = boardWith(M, [], [0, 0]);
        expect(cpuNext(level, M, none, 0, mulberry32(8))).toEqual({ kind: "end" });
      }
    });
  });
});
