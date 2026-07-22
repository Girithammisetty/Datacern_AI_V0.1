/**
 * Hex <-> "H S% L%" HSL-triplet conversion (BRD 59 WS3). The backend stores
 * and the app applies bare HSL triplets (globals.css's CSS custom-property
 * format); `<input type="color">` only speaks hex — these are the two small
 * client-only conversions between them, kept out of the component for testing.
 */

/** "#rrggbb" -> "H S% L%" (H in whole degrees, S/L in whole percent). */
export function hexToHsl(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "";
  const r = parseInt(m[1].slice(0, 2), 16) / 255;
  const g = parseInt(m[1].slice(2, 4), 16) / 255;
  const b = parseInt(m[1].slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return `0 0% ${Math.round(l * 100)}%`;
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)) * 60; break;
    case g: h = ((b - r) / d + 2) * 60; break;
    default: h = ((r - g) / d + 4) * 60;
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/** "H S% L%" -> "#rrggbb". Falls back to `fallbackHex` for an empty/unset or
 * malformed triplet (the platform default, since <input type="color"> always
 * needs a valid hex value to display). */
export function hslToHex(hsl: string, fallbackHex: string): string {
  const m = /^(\d{1,3}(?:\.\d+)?)\s+(\d{1,3}(?:\.\d+)?)%\s+(\d{1,3}(?:\.\d+)?)%$/.exec(hsl.trim());
  if (!m) return fallbackHex;
  const h = parseFloat(m[1]) / 360;
  const s = parseFloat(m[2]) / 100;
  const l = parseFloat(m[3]) / 100;
  if (s === 0) {
    const v = Math.round(l * 255);
    return `#${[v, v, v].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const r = Math.round(hue(h + 1 / 3) * 255);
  const g = Math.round(hue(h) * 255);
  const b = Math.round(hue(h - 1 / 3) * 255);
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
