import { describe, expect, test } from "vitest";
import { COURSE_LENGTHS, COURSE_METRES, CP_BACK, DIFFICULTIES, courseId, generateCourse } from "../src/shared/course";
import courseSource from "../src/shared/course.ts?raw";

const SPECS = COURSE_LENGTHS.flatMap((length) => DIFFICULTIES.map((difficulty) => ({ length, difficulty })));

describe("generated courses", () => {
  test("the same spec builds the same course, bit for bit", () => {
    const a = generateCourse({ seed: 12345, length: "medium", difficulty: "hard" });
    const b = generateCourse({ seed: 12345, length: "medium", difficulty: "hard" });
    expect(Array.from(b.ground.xs)).toEqual(Array.from(a.ground.xs));
    expect(Array.from(b.ground.ys)).toEqual(Array.from(a.ground.ys));
    expect(b.checkpoints).toEqual(a.checkpoints);
    expect(b.pits).toEqual(a.pits);
    expect(b.id).toBe(a.id);
  });

  test("a seed gives each length and difficulty its own course", () => {
    const ids = new Set(SPECS.map((s) => courseId({ seed: 1, ...s })));
    expect(ids.size).toBe(SPECS.length);
    const easy = generateCourse({ seed: 1, length: "short", difficulty: "easy" });
    const hard = generateCourse({ seed: 1, length: "short", difficulty: "hard" });
    expect(hard.pieces.map((p) => p.kind)).not.toEqual(easy.pieces.map((p) => p.kind));
  });

  test("the generator keeps to the sim's deterministic arithmetic", () => {
    const code = courseSource.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/Math\.(?!sqrt|abs|min|max|floor|round|imul)\w+/);
    expect(code).not.toMatch(/\*\*/);
  });

  // Every combination over many seeds: the shape rules the sim, the respawns and the camera need.
  test.each(SPECS)("$length $difficulty courses are well formed", ({ length, difficulty }) => {
    for (let seed = 1; seed <= 150; seed++) {
      const c = generateCourse({ seed, length, difficulty });
      const g = c.ground;
      // Left to right, never back (no overhangs).
      for (let i = 1; i < g.n; i++) expect(g.xs[i]).toBeGreaterThanOrEqual(g.xs[i - 1]);
      // About the length asked for.
      expect(c.finishX).toBeGreaterThan(COURSE_METRES[length]);
      expect(c.finishX).toBeLessThan(COURSE_METRES[length] + 80);
      // The gate, every checkpoint and the finish are on flat ground, with room to get going.
      expect(c.checkpoints[0]).toBe(0);
      for (const x of [...c.checkpoints, c.finishX]) {
        const y = g.heightAt(x);
        for (const dx of [-1.5, -0.7, 0.7, 1.5]) expect(g.heightAt(x + dx)).toBe(y);
      }
      for (let i = 1; i < c.checkpoints.length; i++) {
        expect(c.checkpoints[i]).toBeGreaterThan(c.checkpoints[i - 1] + 40);
        // A checkpoint is CP_BACK before a piece, on its run-up.
        expect(c.pieces.some((p) => Math.abs(p.x0 - CP_BACK - c.checkpoints[i]) < 1e-9)).toBe(true);
      }
      expect(c.checkpoints.at(-1)!).toBeLessThan(c.finishX);
      // Pits are inside gaps, below the ground on both sides.
      for (const pit of c.pits ?? []) {
        expect(c.pieces.some((p) => p.kind === "gap" && pit.x0 > p.x0 && pit.x1 < p.x1)).toBe(true);
        expect(g.heightAt((pit.x0 + pit.x1) / 2)).toBeLessThan(pit.y - 1);
      }
      // The course stays within a band of heights.
      for (let i = 0; i < g.n; i++) {
        expect(g.ys[i]).toBeLessThan(45);
        expect(g.ys[i]).toBeGreaterThan(-30);
      }
      expect(c.capTicks).toBe(c.parTicks * 3);
    }
  });

  test("slopes you ride up or down are no steeper than about 40°, apart from faces and take-offs", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const c = generateCourse({ seed, length: "medium", difficulty: "hard" });
      const g = c.ground;
      for (const piece of c.pieces) {
        if (!["hill", "climb", "descent"].includes(piece.kind)) continue;
        for (let i = 1; i < g.n; i++) {
          if (g.xs[i - 1] < piece.x0 || g.xs[i] > piece.x1) continue;
          const dx = g.xs[i] - g.xs[i - 1];
          const dy = g.ys[i] - g.ys[i - 1];
          if (dx > 0) expect(Math.abs(dy / dx)).toBeLessThan(0.84);
        }
      }
    }
  });
});
