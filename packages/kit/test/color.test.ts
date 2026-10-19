// Colour arithmetic for canvas drawing.
import { describe, expect, it } from "vitest";
import { hexToRgb, mix, rgba, shade } from "../src/client/color";

describe("colours", () => {
  it("reads and blends #rrggbb colours", () => {
    expect(hexToRgb("#ff8000")).toEqual([255, 128, 0]);
    expect(mix([0, 0, 0], [255, 255, 255], 0.5)).toEqual([127.5, 127.5, 127.5]);
    expect(rgba("#ff8000", 0.5)).toBe("rgba(255, 128, 0, 0.5)");
  });

  it("shades towards white or black", () => {
    expect(shade("#ff8000", 0)).toBe("rgb(255, 128, 0)");
    expect(shade("#ff8000", 0.5)).toBe("rgb(255, 192, 128)");
    expect(shade("#ff8000", -0.5)).toBe("rgb(128, 64, 0)");
    expect(shade("#ff8000", 1)).toBe("rgb(255, 255, 255)");
    expect(shade("#ff8000", -1)).toBe("rgb(0, 0, 0)");
  });
});
