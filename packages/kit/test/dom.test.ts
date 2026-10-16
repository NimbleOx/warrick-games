// The player's name, shared by every game on the site, and personal bests, in a fake localStorage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { personalBest, saveSharedName, setStorePrefix, sharedName, store } from "../src/client/dom";

let data: Map<string, string>;

beforeEach(() => {
  data = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
    removeItem: (k: string) => data.delete(k),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the player's name", () => {
  it("follows the player from one game to the next", () => {
    setStorePrefix("cc");
    expect(sharedName()).toBeNull();
    saveSharedName("Ann");
    setStorePrefix("lc");
    expect(sharedName()).toBe("Ann");
    saveSharedName("Annie");
    setStorePrefix("cc");
    expect(sharedName()).toBe("Annie");
  });

  it("starts from a name one game saved before names were shared", () => {
    setStorePrefix("cc");
    store("name", "Bo");
    expect(sharedName()).toBe("Bo");
    // Another game has nothing of its own, and nothing shared yet.
    setStorePrefix("lc");
    expect(sharedName()).toBeNull();
    // Once saved, the shared name wins everywhere.
    saveSharedName("Cy");
    setStorePrefix("cc");
    expect(sharedName()).toBe("Cy");
  });

  it("does without storage (private mode)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    });
    expect(() => saveSharedName("Dee")).not.toThrow();
    expect(sharedName()).toBeNull();
  });
});

describe("personal bests", () => {
  it("keeps the best score under the game's prefix", () => {
    setStorePrefix("sa");
    expect(personalBest("best", "AAAAA:1", 500)).toEqual({ best: 500, prev: null, fresh: true });
    expect(personalBest("best", "AAAAA:2", 300)).toEqual({ best: 500, prev: 500, fresh: false });
    expect(personalBest("best", "AAAAA:3", 800)).toEqual({ best: 800, prev: 500, fresh: true });
    expect(personalBest("best", "AAAAA:4", 800)).toEqual({ best: 800, prev: 800, fresh: false });
    expect(data.has("sa.best")).toBe(true);
    // Another game has its own.
    setStorePrefix("dt");
    expect(personalBest("best", "AAAAA:3", 10)).toEqual({ best: 10, prev: null, fresh: true });
  });

  it("counts a run once, however often its results are shown", () => {
    setStorePrefix("pp");
    personalBest("best", "BBBBB:1", 100);
    expect(personalBest("best", "BBBBB:2", 400)).toEqual({ best: 400, prev: 100, fresh: true });
    expect(personalBest("best", "BBBBB:2", 400)).toEqual({ best: 400, prev: 100, fresh: true });
  });

  it("takes negative scores, and starts again from something it can't read", () => {
    setStorePrefix("cs");
    store("best", "not json");
    expect(personalBest("best", "CCCCC:1", -12)).toEqual({ best: -12, prev: null, fresh: true });
    expect(personalBest("best", "CCCCC:2", -3)).toEqual({ best: -3, prev: -12, fresh: true });
  });
});
