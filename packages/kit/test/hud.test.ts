// The turn clock and the feed, on fake elements.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatSeconds } from "../src/client/format";
import { Feed, showClock } from "../src/client/hud";

/** Just enough of an element: text, classes, and the feed's list items, read back from its markup. */
function fakeEl() {
  const classes = new Set<string>();
  const items = new Map<
    string,
    {
      dataset: { at: string };
      classList: Set<string> & { add(c: string): void };
    }
  >();
  const el = {
    textContent: "",
    innerHTML: "",
    classList: {
      toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c: string) => classes.has(c),
    },
    querySelectorAll: () =>
      [...el.innerHTML.matchAll(/data-at="([^"]+)"/g)].map(([, at]) => {
        if (!items.has(at)) items.set(at, { dataset: { at }, classList: new Set<string>() });
        return items.get(at)!;
      }),
    lines: () => [...el.innerHTML.matchAll(/<li data-at="([^"]+)">(.*?)<\/li>/g)].map((m) => m[2]),
    old: () => [...items.values()].filter((i) => i.classList.has("old")).length,
  };
  return el;
}

describe("the turn clock", () => {
  it("shows the time left, nothing without a clock, and goes low under the threshold", () => {
    const el = fakeEl();
    const show = (ms: number | null) => showClock(el as unknown as HTMLElement, ms, 10_000);
    expect(show(65_000)).toBe("1:05");
    expect(el.textContent).toBe("1:05");
    expect(el.classList.contains("low")).toBe(false);
    show(9_001);
    expect(el.textContent).toBe("0:10");
    expect(el.classList.contains("low")).toBe(true);
    show(null);
    expect(el.textContent).toBe("");
    expect(el.classList.contains("low")).toBe(false);
  });

  it("takes another format, and returns the text even with no element", () => {
    expect(showClock(null, 4_200, 5_000, formatSeconds)).toBe("5s");
    expect(showClock(null, null, 5_000, formatSeconds)).toBe("");
  });
});

describe("the feed", () => {
  let el: ReturnType<typeof fakeEl>;
  let now = 0;

  beforeEach(() => {
    el = fakeEl();
    now = 1000;
    vi.stubGlobal("document", { getElementById: () => el });
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the newest five lines", () => {
    const feed = new Feed();
    for (let i = 1; i <= 7; i++) {
      now += 10;
      feed.push(`line ${i}`);
    }
    expect(el.lines()).toEqual(["line 3", "line 4", "line 5", "line 6", "line 7"]);
  });

  it("fades lines once the oldest has been up five seconds, and drops them a moment later", () => {
    const feed = new Feed();
    feed.push("first");
    now += 1000;
    feed.push("second");
    feed.age(now + 3900); // the first has been up 4.9s
    expect(el.old()).toBe(0);
    feed.age(now + 4100); // 5.1s: the first fades
    expect(el.old()).toBe(1);
    expect(el.lines()).toEqual(["first", "second"]);
    feed.age(now + 4300); // 5.3s: the first goes
    expect(el.lines()).toEqual(["second"]);
    feed.age(now + 6300); // the second has been up 6.3s
    expect(el.lines()).toEqual([]);
  });

  it("empties the list when cleared", () => {
    const feed = new Feed();
    feed.push("a");
    feed.clear();
    expect(el.innerHTML).toBe("");
  });
});
