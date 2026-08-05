/**
 * Fullscreen ("TV mode") helpers over the Fullscreen API. There were zero
 * fullscreen references in the codebase before this; kept as a tiny pure-ish
 * module so the toggle logic is unit-testable without a real browser (jsdom
 * lacks requestFullscreen). Esc exit is handled natively by the browser.
 */
"use client";

/** True when some element is currently presented fullscreen. */
export function isFullscreenActive(): boolean {
  return typeof document !== "undefined" && document.fullscreenElement != null;
}

/**
 * Toggle fullscreen for `el`: request it when nothing is fullscreen, otherwise
 * exit. Safe to call in environments without the API (no-ops). Returns the
 * intended next state (true = entering) for callers that want it.
 */
export function toggleFullscreen(el: Element | null): boolean {
  if (typeof document === "undefined" || !el) return false;
  if (document.fullscreenElement) {
    if (typeof document.exitFullscreen === "function") void document.exitFullscreen();
    return false;
  }
  const node = el as HTMLElement & { requestFullscreen?: () => Promise<void> };
  if (typeof node.requestFullscreen === "function") void node.requestFullscreen();
  return true;
}
