import { describe, expect, it } from "vitest";
import { Pilot, type Handling } from "../src/client/pilot";
import { Lane } from "../src/shared/engine";

describe("pilot", () => {
  it("moves the next piece at the repeat rate when a direction stays held", () => {
    const handling: Handling = { das: 150, arr: 30, sdf: 20 };
    const pilot = new Pilot(new Lane(1), () => handling, { locked() {}, moved() {} });
    let now = 0;
    pilot.start(now);
    pilot.press("right", now);
    for (; now < 2000; now += 16) pilot.update(now, 16, 1);
    // Drop this one: the next piece appears with right still held.
    pilot.press("hard", now);
    const xs = [pilot.active!.x];
    for (let i = 0; i < 10; i++) {
      now += 16;
      pilot.update(now, 16, 1);
      xs.push(pilot.active!.x);
    }
    // One column per 30 ms at most, so a frame moves it one column, not all the way to the wall.
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeLessThanOrEqual(1);
    expect(xs.at(-1)).toBeGreaterThan(xs[0]);
  });
});
