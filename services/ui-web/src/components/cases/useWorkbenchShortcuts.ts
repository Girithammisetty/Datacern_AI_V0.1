"use client";
/**
 * Page-scoped keyboard shortcuts for the Case Workbench (UI keyboard-first).
 *
 * A single document-level keydown listener, but mounted ONLY while the
 * workbench is on screen, so it is effectively page-scoped and disappears with
 * the page. It never fires on a modifier combo (so ⌘K / browser shortcuts are
 * untouched), never while the caller is typing in an input/textarea/select or
 * contenteditable, and never inside an open dialog (so `r` in a resolution note
 * types an "r", it does not re-open Resolve).
 *
 * Handlers live in a ref so a re-render never re-subscribes the listener and
 * the callbacks are always current — no stale `rows`/`activeId` closures.
 */
import { useEffect, useRef } from "react";

export interface WorkbenchShortcutHandlers {
  /** j — advance selection to the next case (or select the first). */
  onNext: () => void;
  /** k — move selection to the previous case. */
  onPrev: () => void;
  /** Enter — move focus into the open case pane. */
  onFocusPane: () => void;
  /** / — focus the search box. */
  onFocusSearch: () => void;
  /** r — Resolve the selected case (opens its disposition control). */
  onResolve: () => void;
  /** e — Escalate the selected case, if available. */
  onEscalate: () => void;
  /** a — Assign the selected case. */
  onAssign: () => void;
  /** ? — open the shortcut cheatsheet. */
  onHelp: () => void;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** Enter is only hijacked to focus the pane from "neutral" focus — never from a
 * grid row, button or link, whose own Enter behavior (activate/open) must win. */
function isNeutralTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return true; // document.body etc.
  return !el.closest('[data-row-index],button,a,[role="row"],[role="button"]');
}

export function useWorkbenchShortcuts(handlers: WorkbenchShortcutHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return; // leave ⌘K & friends alone
      if (isTypingTarget(e.target)) return;
      if (e.target instanceof HTMLElement && e.target.closest('[role="dialog"]')) return;
      const h = ref.current;
      // "?" is Shift+/ on most layouts; allow the Shift there but nowhere else.
      if (e.key === "?") {
        e.preventDefault();
        h.onHelp();
        return;
      }
      if (e.shiftKey) return;
      switch (e.key) {
        case "j":
          e.preventDefault();
          h.onNext();
          break;
        case "k":
          e.preventDefault();
          h.onPrev();
          break;
        case "Enter":
          if (isNeutralTarget(e.target)) {
            e.preventDefault();
            h.onFocusPane();
          }
          break;
        case "/":
          e.preventDefault();
          h.onFocusSearch();
          break;
        case "r":
          e.preventDefault();
          h.onResolve();
          break;
        case "e":
          e.preventDefault();
          h.onEscalate();
          break;
        case "a":
          e.preventDefault();
          h.onAssign();
          break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
