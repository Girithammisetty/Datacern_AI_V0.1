"use client";
/**
 * Product tour (ease-of-use initiative) — a guided walk through the viewer's
 * OWN getting-started checklist. One content source, not two: the steps ARE
 * `visibleTracks(can)` from lib/onboarding/checklist, so the tour is
 * role-aware for free (same capability gates as the nav) and can never drift
 * from the checklist it teaches.
 *
 * UX mirrors the proven demo WalkthroughOverlay: a non-blocking bottom-LEFT
 * narrator panel (bottom-right belongs to the demo overlay, which can coexist
 * on demo tenants) — the viewer keeps using the real page underneath. Touring
 * a step does NOT check it off: visiting isn't doing, and completion stays a
 * deliberate user action on the checklist.
 */
import { useRouter, usePathname } from "next/navigation";
import { Compass, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { visibleTracks } from "@/lib/onboarding/checklist";
import { useCapabilities } from "@/lib/authz/useCapabilities";
import { useProductTour } from "@/stores/ui";

export function ProductTourOverlay() {
  const { can, isLoading } = useCapabilities();
  const tour = useProductTour();
  const router = useRouter();
  const pathname = usePathname();

  if (!tour.active || isLoading) return null;

  // Flatten the viewer's checklist into tour steps, keeping the track title
  // as a kicker so the step reads in context ("Working cases · Open your worklist").
  const steps = visibleTracks(can).flatMap((track) =>
    track.items.map((item) => ({ track: track.title, ...item })),
  );
  const step = steps[tour.stepIndex];
  if (!step) return null;

  const isLast = tour.stepIndex >= steps.length - 1;
  const onRoute = pathname === step.href;

  const goNext = () => {
    if (isLast) {
      tour.stop();
      return;
    }
    const next = steps[tour.stepIndex + 1];
    tour.next();
    if (next) router.push(next.href);
  };
  const goPrev = () => {
    const prev = steps[tour.stepIndex - 1];
    tour.prev();
    if (prev) router.push(prev.href);
  };

  return (
    <div
      role="dialog"
      aria-label="Product tour"
      className="fixed bottom-4 left-4 z-40 w-full max-w-sm rounded-lg border bg-card p-4 shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Compass className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            {step.track} — step {tour.stepIndex + 1} of {steps.length}
          </span>
        </div>
        <button
          type="button"
          aria-label="End product tour"
          onClick={tour.stop}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <h3 className="mt-2 text-sm font-semibold">{step.title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{step.description}</p>

      {!onRoute && (
        <Button variant="outline" size="sm" className="mt-3 w-full" onClick={() => router.push(step.href)}>
          Go to this step
        </Button>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={goPrev} disabled={tour.stepIndex === 0}>
          Back
        </Button>
        <Button size="sm" onClick={goNext}>
          {isLast ? "Finish" : "Next"}
        </Button>
      </div>
    </div>
  );
}
