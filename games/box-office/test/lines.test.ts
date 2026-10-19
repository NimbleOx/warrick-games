// The client's queue of lines still to draw: timers play them one at a time, a long run faster,
// and it draws everything at once when it falls behind. No animation frames are involved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LATE_MS, LineQueue, SNAP_BACKLOG, lineGap } from "../src/client/lines";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

/** A queue on the fake clock, and what it drew: each batch of lines, when, and whether quietly. */
function queue() {
  const start = Date.now();
  const shown: { edges: number[]; at: number; quiet: boolean }[] = [];
  const done: { at: number; quiet: boolean }[] = [];
  const q = new LineQueue(
    {
      show: (edges, quiet) => shown.push({ edges, at: Date.now() - start, quiet }),
      done: (quiet) => done.push({ at: Date.now() - start, quiet }),
    },
    () => Date.now(),
  );
  return { q, shown, done };
}

describe("the line queue", () => {
  it("plays lines one at a time, with a pause after each", () => {
    const { q, shown, done } = queue();
    q.push([4, 7, 9]);
    expect(q.length).toBe(3);
    vi.advanceTimersByTime(0);
    expect(shown).toEqual([{ edges: [4], at: 0, quiet: false }]);
    vi.advanceTimersByTime(1000);
    expect(shown.map((s) => [s.edges[0], s.at])).toEqual([
      [4, 0],
      [7, 140],
      [9, 280],
    ]);
    expect(done).toEqual([{ at: 280, quiet: false }]);
    expect(q.busy).toBe(false);
  });

  it("plays a long run faster", () => {
    const { q, shown } = queue();
    const run = Array.from({ length: 12 }, (_, i) => i);
    q.push(run);
    vi.advanceTimersByTime(5000);
    expect(shown.map((s) => s.edges[0])).toEqual(run);
    const gaps = shown.slice(1).map((s, i) => s.at - shown[i].at);
    expect(gaps).toEqual(run.slice(1).map((_, i) => lineGap(run.length - 1 - i)));
    expect(gaps[0]).toBe(45);
    expect(gaps.at(-1)).toBe(140);
  });

  it("keeps the pause after a line when the next state comes quickly", () => {
    const { q, shown } = queue();
    q.push([1]);
    vi.advanceTimersByTime(50);
    q.push([2]);
    vi.advanceTimersByTime(200);
    expect(shown.map((s) => s.at)).toEqual([0, 140]);
  });

  it("plays a line straight away when the last one was long ago", () => {
    const { q, shown } = queue();
    q.push([1]);
    vi.advanceTimersByTime(10_000);
    q.push([2]);
    vi.advanceTimersByTime(0);
    expect(shown.map((s) => ({ at: s.at, quiet: s.quiet }))).toEqual([
      { at: 0, quiet: false },
      { at: 10_000, quiet: false },
    ]);
  });

  it("draws a long backlog at once, quietly and in order", () => {
    const { q, shown, done } = queue();
    q.push([1, 2]);
    const more = Array.from({ length: SNAP_BACKLOG }, (_, i) => 10 + i);
    q.push(more);
    expect(shown).toEqual([{ edges: [1, 2, ...more], at: 0, quiet: true }]);
    expect(done).toEqual([{ at: 0, quiet: true }]);
    expect(q.busy).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(shown).toHaveLength(1);
  });

  it("draws the rest at once when a timer comes late (a throttled page)", () => {
    const { q, shown, done } = queue();
    q.push([1, 2, 3, 4]);
    vi.advanceTimersByTime(0);
    expect(shown).toHaveLength(1);
    // The next timer was due in 140 ms, but the page was throttled for a few seconds.
    vi.setSystemTime(Date.now() + LATE_MS + 3000);
    vi.advanceTimersByTime(140);
    expect(shown.map((s) => ({ edges: s.edges, quiet: s.quiet }))).toEqual([
      { edges: [1], quiet: false },
      { edges: [2, 3, 4], quiet: true },
    ]);
    expect(done.map((d) => d.quiet)).toEqual([true]);
  });

  it("flush draws what's waiting now; clear forgets it", () => {
    const { q, shown, done } = queue();
    q.push([1, 2, 3]);
    q.flush();
    expect(shown).toEqual([{ edges: [1, 2, 3], at: 0, quiet: true }]);
    q.push([4, 5]);
    q.clear();
    vi.advanceTimersByTime(5000);
    expect(shown).toHaveLength(1);
    expect(done).toHaveLength(1);
    expect(q.busy).toBe(false);
    q.flush();
    expect(shown).toHaveLength(1);
  });

  it("keeps up with a whole game of CPU lines without falling behind", () => {
    const { q, shown } = queue();
    // A CPU capture run: a line every 250 ms, a few hundred of them.
    let most = 0;
    for (let i = 0; i < 195; i++) {
      q.push([i]);
      most = Math.max(most, q.length);
      vi.advanceTimersByTime(250);
    }
    expect(most).toBe(1);
    expect(shown.flatMap((s) => s.edges)).toEqual(Array.from({ length: 195 }, (_, i) => i));
    expect(shown.every((s) => !s.quiet)).toBe(true);
  });
});
