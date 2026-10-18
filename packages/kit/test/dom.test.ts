// The player's name, shared by every game on the site, in a fake localStorage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveSharedName, setStorePrefix, sharedName, store } from "../src/client/dom";

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
