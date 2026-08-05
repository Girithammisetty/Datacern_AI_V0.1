import { describe, it, expect, vi, afterEach } from "vitest";
import { isFullscreenActive, toggleFullscreen } from "./fullscreen";

function setFullscreenElement(el: Element | null) {
  Object.defineProperty(document, "fullscreenElement", { value: el, configurable: true, writable: true });
}

afterEach(() => {
  setFullscreenElement(null);
  vi.restoreAllMocks();
});

describe("toggleFullscreen", () => {
  it("requests fullscreen on the element when nothing is fullscreen", () => {
    setFullscreenElement(null);
    const el = document.createElement("div");
    const request = vi.fn().mockResolvedValue(undefined);
    (el as unknown as { requestFullscreen: () => Promise<void> }).requestFullscreen = request;

    const entering = toggleFullscreen(el);

    expect(request).toHaveBeenCalledTimes(1);
    expect(entering).toBe(true);
  });

  it("exits fullscreen when an element is already fullscreen", () => {
    const el = document.createElement("div");
    setFullscreenElement(el);
    const exit = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(document, "exitFullscreen", { value: exit, configurable: true, writable: true });

    const entering = toggleFullscreen(el);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(entering).toBe(false);
  });

  it("no-ops on a null element", () => {
    expect(() => toggleFullscreen(null)).not.toThrow();
  });

  it("isFullscreenActive reflects document.fullscreenElement", () => {
    setFullscreenElement(null);
    expect(isFullscreenActive()).toBe(false);
    setFullscreenElement(document.createElement("div"));
    expect(isFullscreenActive()).toBe(true);
  });
});
