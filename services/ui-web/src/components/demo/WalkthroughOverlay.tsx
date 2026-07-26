"use client";
import { useRouter, usePathname } from "next/navigation";
import { Compass, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/session/SessionContext";
import { useWalkthrough } from "@/lib/walkthrough/useWalkthrough";
import { useWalkthroughProgress } from "@/lib/walkthrough/useWalkthroughProgress";

/**
 * Guided-walkthrough overlay (BRD 70 DSP-FR-015). Renders a non-blocking,
 * bottom-right panel for the current step of the caller tenant's
 * walkthrough.yaml script (§2.2 of docs/initiatives/demo-sandbox-poc-mode.md)
 * — deliberately NOT a modal dialog (unlike ConfirmDialog): a step's whole
 * point is that the viewer keeps interacting with the real page underneath
 * while the panel narrates it, matching the shipped bundle's steps (title +
 * target_route + narration, deploy/demo/insurance-claims-payer/
 * walkthrough.yaml) rather than pointing at individual DOM elements (the
 * bundle format has no per-element selector to point at).
 *
 * Gated the same way DemoWatermarkBanner is (`session.profile === "demo"`),
 * so it never fetches or renders for a standard/poc tenant. Mounted once in
 * AppShell's ShellInner, available across every page.
 */
export function WalkthroughOverlay() {
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const isDemo = session.profile === "demo";

  const walkthrough = useWalkthrough(isDemo);
  const steps = walkthrough.data ?? [];
  const progress = useWalkthroughProgress(session.tenantId, steps.length);

  if (!isDemo || steps.length === 0) return null;
  if (progress.isDismissed) {
    return (
      <button
        type="button"
        onClick={progress.restart}
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full border bg-card px-3 py-2 text-xs font-medium text-muted-foreground shadow-lg hover:text-foreground"
      >
        <Compass className="h-3.5 w-3.5" aria-hidden="true" />
        Resume guided tour
      </button>
    );
  }

  const step = steps[progress.stepIndex];
  if (!step) return null;

  const isLastStep = progress.stepIndex >= steps.length - 1;
  const onThisStepsRoute = pathname === step.target_route;

  function goToStep(): void {
    router.push(step.target_route);
  }

  function handleNext(): void {
    if (isLastStep) {
      progress.finish();
      return;
    }
    const nextStep = steps[progress.stepIndex + 1];
    progress.next();
    if (nextStep) router.push(nextStep.target_route);
  }

  function handlePrev(): void {
    const prevStep = steps[progress.stepIndex - 1];
    progress.prev();
    if (prevStep) router.push(prevStep.target_route);
  }

  return (
    <div
      role="dialog"
      aria-label="Guided tour"
      className="fixed bottom-4 right-4 z-40 w-full max-w-sm rounded-lg border bg-card p-4 shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Compass className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            Guided tour — step {progress.stepIndex + 1} of {steps.length}
          </span>
        </div>
        <button
          type="button"
          aria-label="Skip guided tour"
          onClick={progress.skip}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <h3 className="mt-2 text-sm font-semibold">{step.title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{step.narration}</p>

      {!onThisStepsRoute && (
        <Button variant="outline" size="sm" className="mt-3 w-full" onClick={goToStep}>
          Go to this step
        </Button>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={handlePrev} disabled={progress.stepIndex === 0}>
          Back
        </Button>
        <Button size="sm" onClick={handleNext}>
          {isLastStep ? "Finish" : "Next"}
        </Button>
      </div>
    </div>
  );
}
