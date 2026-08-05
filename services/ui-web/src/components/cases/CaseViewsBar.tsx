"use client";
/**
 * Saved-views chip row for the Case Workbench. A view is just a named bundle
 * of worklist URL params (lib/cases/views.ts): clicking a chip rewrites the
 * URL, so the URL stays the source of truth and every view is a shareable
 * link. Three built-ins need no persistence; user views persist per-user in
 * localStorage (`datacern.cases.views.v1`). The active chip is detected by
 * structural equality with the CURRENT URL params — not by remembering what
 * was clicked — so a hand-edited URL lights up the matching chip too.
 */
import { useState } from "react";
import { Bookmark, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { useSession } from "@/lib/session/SessionContext";
import { cn } from "@/lib/utils";
import {
  BUILTIN_CASE_VIEWS,
  loadSavedViews,
  persistSavedViews,
  viewParamsEqual,
  viewParamsToSearch,
  type CaseViewParams,
  type SavedCaseView,
} from "@/lib/cases/views";

export function CaseViewsBar({
  current,
  onApply,
}: {
  current: CaseViewParams;
  onApply: (params: CaseViewParams) => void;
}) {
  const { userId } = useSession();
  const [views, setViews] = useState<SavedCaseView[]>(() => loadSavedViews(userId));
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  // "Save current as view" only makes sense when the URL carries some state.
  const hasState = viewParamsToSearch(current).length > 0;
  const alreadySaved =
    BUILTIN_CASE_VIEWS.some((v) => viewParamsEqual(v.params, current)) ||
    views.some((v) => viewParamsEqual(v.params, current));

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next = [...views, { id: crypto.randomUUID(), name: trimmed, params: current }];
    setViews(next);
    persistSavedViews(userId, next);
    setNaming(false);
    setName("");
  };

  const remove = (id: string) => {
    const next = views.filter((v) => v.id !== id);
    setViews(next);
    persistSavedViews(userId, next);
  };

  const chip = (active: boolean) =>
    cn(
      "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
      active
        ? "border-primary bg-primary/10 text-foreground"
        : "border-input text-muted-foreground hover:bg-accent hover:text-foreground",
    );

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" aria-label="Saved views">
      {BUILTIN_CASE_VIEWS.map((v) => {
        const active = viewParamsEqual(v.params, current);
        return (
          <button
            key={v.key}
            type="button"
            aria-pressed={active}
            className={chip(active)}
            onClick={() => onApply(active ? {} : v.params)}
            title={active ? "Click to clear this view" : undefined}
          >
            {v.name}
          </button>
        );
      })}
      {views.map((v) => {
        const active = viewParamsEqual(v.params, current);
        return (
          <span key={v.id} className={cn(chip(active), "pr-1")}>
            <button
              type="button"
              aria-pressed={active}
              className="focus:outline-none"
              onClick={() => onApply(active ? {} : v.params)}
            >
              {v.name}
            </button>
            <button
              type="button"
              aria-label={`Delete view ${v.name}`}
              className="rounded-full p-0.5 hover:bg-muted"
              onClick={() => remove(v.id)}
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        );
      })}

      {naming ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="View name…"
            aria-label="View name"
            className="h-7 w-40 text-xs"
          />
          <Button type="submit" size="sm" variant="secondary" disabled={!name.trim()}>
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => { setNaming(false); setName(""); }}>
            Cancel
          </Button>
        </form>
      ) : (
        hasState &&
        !alreadySaved && (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setNaming(true)}>
            <Bookmark className="mr-1 size-3" aria-hidden />
            Save current as view
          </Button>
        )
      )}
    </div>
  );
}
