import { describe, it, expect } from "vitest";
import { hexToHsl, hslToHex } from "./color";

describe("hexToHsl / hslToHex", () => {
  it("round-trips the platform default primary color", () => {
    // globals.css --primary: 190 80% 34% (brand teal)
    const hex = hslToHex("190 80% 34%", "#000000");
    expect(hexToHsl(hex)).toBe("190 80% 34%");
  });

  it("round-trips a light low-saturation color within hex quantization", () => {
    // globals.css --accent (190 44% 92%) is light and low-saturation; 8-bit hex
    // has too few steps there to preserve the exact triple, so the round-trip
    // lands within ~1 unit of saturation — a property of hex, not a bug.
    const hex = hslToHex("190 44% 92%", "#000000");
    expect(hexToHsl(hex)).toBe("190 45% 92%");
  });

  it("hexToHsl handles pure grayscale (s=0 branch)", () => {
    expect(hexToHsl("#808080")).toBe("0 0% 50%");
  });

  it("hslToHex handles pure grayscale (s=0 branch)", () => {
    expect(hslToHex("0 0% 50%", "#000000")).toBe("#808080");
  });

  it("hexToHsl rejects malformed input", () => {
    expect(hexToHsl("not-a-color")).toBe("");
    expect(hexToHsl("#ff")).toBe("");
  });

  it("hslToHex falls back on malformed input", () => {
    expect(hslToHex("", "#123456")).toBe("#123456");
    expect(hslToHex("hsl(221, 83%, 53%)", "#123456")).toBe("#123456");
  });

  it("hexToHsl accepts hex without a leading #", () => {
    expect(hexToHsl("808080")).toBe("0 0% 50%");
  });
});
