/**
 * The determinism check, to open in every browser (check.html): it replays the recorded rides
 * and compares their hashes with the ones Node got (test/fixtures). Every browser must match,
 * because the client and the worker step the same bikes. It also times a step.
 */

import { randomInputs, replay, rideHash, type InputEvent } from "../shared/ride";
import { sandboxCourse } from "../shared/sandbox";
import golden from "../../test/fixtures/ride.json";
import random from "../../test/fixtures/random.json";

const course = sandboxCourse();
const rides: { name: string; events: InputEvent[]; ticks: number; hash: string }[] = [
  { name: "Recorded ride", events: golden.events as InputEvent[], ticks: golden.ticks, hash: golden.hash },
  { name: "Random ride", events: randomInputs(random.seed, random.ticks), ticks: random.ticks, hash: random.hash },
];

const results = rides.map((r) => {
  const got = rideHash(replay(course, r.events, r.ticks));
  return { ...r, got, ok: got === r.hash };
});

// The cost of a step: the best of several replays of the recorded ride, after a warm-up.
for (let i = 0; i < 5; i++) replay(course, rides[0].events, rides[0].ticks);
let best = Infinity;
for (let i = 0; i < 10; i++) {
  const t0 = performance.now();
  replay(course, rides[0].events, rides[0].ticks);
  best = Math.min(best, performance.now() - t0);
}
const us = (best * 1000) / rides[0].ticks;

const ok = results.every((r) => r.ok);
document.title = `${ok ? "PASS" : "FAIL"} ${results.map((r) => r.got).join(" ")} ${us.toFixed(2)}us`;
const out = document.getElementById("out") as HTMLElement;
out.innerHTML = `
  <h1 class="${ok ? "pass" : "fail"}">${ok ? "PASS" : "FAIL"}</h1>
  <table>
    ${results
      .map(
        (r) =>
          `<tr><td>${r.name}</td><td>${r.ticks} ticks</td><td>${r.got}</td><td>${r.ok ? "✓" : `✗ expected ${r.hash}`}</td></tr>`,
      )
      .join("")}
  </table>
  <p>${us.toFixed(2)} µs per step</p>
  <p class="ua">${navigator.userAgent.replace(/[<>&]/g, "")}</p>`;
