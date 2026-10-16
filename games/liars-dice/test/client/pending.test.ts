import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pending } from "../../src/client/pending";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a move on its way", () => {
  it("is given up on if the server doesn't answer", () => {
    const timedOut = vi.fn();
    const move = new Pending(6000, timedOut);
    move.start();
    expect(move.waiting).toBe(true);
    vi.advanceTimersByTime(5999);
    expect(timedOut).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(timedOut).toHaveBeenCalledOnce();
    expect(move.waiting).toBe(false);
  });

  it("isn't given up on when an earlier, answered move's time runs out", () => {
    const timedOut = vi.fn();
    const move = new Pending(6000, timedOut);
    move.start();
    vi.advanceTimersByTime(200);
    move.answered();
    // The next move goes just before the first one's six seconds are up.
    vi.advanceTimersByTime(5700);
    move.start();
    vi.advanceTimersByTime(200);
    expect(timedOut).not.toHaveBeenCalled();
    expect(move.waiting).toBe(true);
    move.answered();
    vi.advanceTimersByTime(60_000);
    expect(timedOut).not.toHaveBeenCalled();
  });
});
