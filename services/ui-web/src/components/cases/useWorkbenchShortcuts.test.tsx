/**
 * The workbench keyboard map, asserted at the handler boundary (jsdom has no
 * layout, so this tests key→callback wiring and the guards, not pixels):
 *  - bare j/k/Enter/r/e/a/'/'/'?' each fire exactly their handler;
 *  - a modifier combo (⌘K and friends) is ignored, so global shortcuts win;
 *  - typing in an input/textarea, or a keystroke inside a dialog, is ignored.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useWorkbenchShortcuts, type WorkbenchShortcutHandlers } from "./useWorkbenchShortcuts";

function makeHandlers(): WorkbenchShortcutHandlers {
  return {
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onFocusPane: vi.fn(),
    onFocusSearch: vi.fn(),
    onResolve: vi.fn(),
    onEscalate: vi.fn(),
    onAssign: vi.fn(),
    onHelp: vi.fn(),
  };
}

function Harness({ handlers }: { handlers: WorkbenchShortcutHandlers }) {
  useWorkbenchShortcuts(handlers);
  return <div data-testid="host" />;
}

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
}

let handlers: WorkbenchShortcutHandlers;
beforeEach(() => {
  handlers = makeHandlers();
  render(<Harness handlers={handlers} />);
});
afterEach(() => cleanup());

describe("useWorkbenchShortcuts key map", () => {
  it("maps each bare key to its handler", () => {
    press("j");
    expect(handlers.onNext).toHaveBeenCalledTimes(1);
    press("k");
    expect(handlers.onPrev).toHaveBeenCalledTimes(1);
    press("r");
    expect(handlers.onResolve).toHaveBeenCalledTimes(1);
    press("e");
    expect(handlers.onEscalate).toHaveBeenCalledTimes(1);
    press("a");
    expect(handlers.onAssign).toHaveBeenCalledTimes(1);
    press("/");
    expect(handlers.onFocusSearch).toHaveBeenCalledTimes(1);
    press("?", { shiftKey: true });
    expect(handlers.onHelp).toHaveBeenCalledTimes(1);
    press("Enter"); // target is document.body → neutral → focuses pane
    expect(handlers.onFocusPane).toHaveBeenCalledTimes(1);
  });

  it("ignores modifier combos so ⌘K / Ctrl shortcuts are untouched", () => {
    press("k", { metaKey: true });
    press("r", { ctrlKey: true });
    press("a", { altKey: true });
    expect(handlers.onPrev).not.toHaveBeenCalled();
    expect(handlers.onResolve).not.toHaveBeenCalled();
    expect(handlers.onAssign).not.toHaveBeenCalled();
  });

  it("ignores keystrokes while typing in a field", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    press("r", {}, input);
    press("j", {}, input);
    expect(handlers.onResolve).not.toHaveBeenCalled();
    expect(handlers.onNext).not.toHaveBeenCalled();
    input.remove();
  });

  it("ignores keystrokes inside an open dialog", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const btn = document.createElement("button");
    dialog.appendChild(btn);
    document.body.appendChild(dialog);
    press("r", {}, btn);
    expect(handlers.onResolve).not.toHaveBeenCalled();
    dialog.remove();
  });
});
