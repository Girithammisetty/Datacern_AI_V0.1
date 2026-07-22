import { describe, it, expect } from "vitest";
import { hexToHsl, hslToHex } from "./color";

describe("hexToHsl / hslToHex", () => {
  it("round-trips the platform default primary color", () => {
    // globals.css --primary: 221 83% 53%
    const hex = hslToHex("221 83% 53%", "#000000");
    expect(hexToHsl(hex)).toBe("221 83% 53%");
  });

  it("round-trips the platform default accent color", () => {
    // globals.css --accent: 210 40% 94%
    const hex = hslToHex("210 40% 94%", "#000000");
    expect(hexToHsl(hex)).toBe("210 40% 94%");
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
