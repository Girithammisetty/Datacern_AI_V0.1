"use client";
/**
 * Getting started — a role-aware first-ten-minutes checklist on Home (ease-of-
 * use initiative). Items carry the SAME capability gates as the nav, so the
 * list adapts to the persona: an analyst sees the casework track, an admin the
 * setup track. Completion is the user checking items off (never claimed from
 * thin air); progress persists client-side per user, and Hide dismisses the
 * card for good. The card also disappears on its own once everything is done.
 */
import Link from "next/link";
import { ArrowRight, CheckCircle2, Circle, Compass, Rocket, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/primitives";
import { visibleTracks } from "@/lib/onboarding/checklist";
import { useOnboardingProgress } from "@/lib/onboarding/useOnboardingProgress";
import { useCapabilities } from "@/lib/authz/useCapabilities";
import { useSession } from "@/lib/session/SessionContext";
import { useProductTour } from "@/stores/ui";

export function OnboardingChecklist() {
  const { can, isLoading } = useCapabilities();
  const session = useSession();
  const progress = useOnboardingProgress(session.tenantId, session.userId);
  const startTour = useProductTour((s) => s.start);

  // Wait for real capabilities — never flash steps the viewer can't open.
  if (isLoading) return null;
  const tracks = visibleTracks(can);
  const all = tracks.flatMap((t) => t.items);
  const doneCount = all.filter((i) => progress.done.includes(i.key)).length;
  if (progress.dismissed || all.length === 0 || doneCount === all.length) return null;

  return (
    <Card data-testid="onboarding-checklist" className="mb-6">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Rocket className="size-4 text-primary" aria-hidden />
              Getting started
            </CardTitle>
            <CardDescription>
              Your first ten minutes — {doneCount} of {all.length} done. Check things off as you go.
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="outline" onClick={startTour}>
              <Compass className="size-4" aria-hidden /> Take the tour
            </Button>
            <Button size="sm" variant="ghost" aria-label="Hide getting started" onClick={progress.dismiss}>
              <X className="size-4" aria-hidden /> Hide
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {tracks.map((track) => (
          <div key={track.key}>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {track.title}
            </p>
            <ul className="space-y-1.5">
              {track.items.map((item) => {
                const done = progress.done.includes(item.key);
                return (
                  <li key={item.key} className="flex items-start gap-2">
                    <button
                      type="button"
                      aria-label={done ? `Mark "${item.title}" as not done` : `Mark "${item.title}" as done`}
                      onClick={() => progress.toggle(item.key)}
                      className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      {done ? (
                        <CheckCircle2 className="size-4 text-primary" aria-hidden />
                      ) : (
                        <Circle className="size-4" aria-hidden />
                      )}
                    </button>
                    <div className="min-w-0">
                      <Link
                        href={item.href}
                        className={`flex items-center gap-1 text-sm font-medium hover:underline ${done ? "text-muted-foreground line-through" : ""}`}
                      >
                        {item.title}
                        <ArrowRight className="size-3 shrink-0 opacity-60" aria-hidden />
                      </Link>
                      <p className="text-xs text-muted-foreground">{item.description}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
