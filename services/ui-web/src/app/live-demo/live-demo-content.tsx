"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from "@/components/ui/primitives";
import { DatacernLogo } from "@/components/brand/DatacernLogo";

type Phase = "form" | "submitting" | "provisioning" | "error";

/** How often to check POST /api/live-demo-signup/claim while a tenant is
 * still provisioning. Matches the visual cadence a spinner needs, well
 * inside identity-service's SelfServeClaimTTL (30 min).
 *
 * UI-FR-012 bans setInterval/timer-refetch polling in favor of SSE via the
 * realtime-hub EventBridge (see src/lib/realtime/useHubTopics.ts) -- the
 * right default for an in-app live view. This page is a deliberate,
 * documented exception: it runs entirely PRE-LOGIN, before any session or
 * tenant claim exists for the hub to scope a subscription to, waiting out a
 * one-time, bounded (a few minutes) provisioning step rather than an
 * ongoing live data stream. A self-rescheduling setTimeout (not
 * setInterval, and not a timer->refetch() chain) is used so a single slow
 * request can't stack overlapping calls. If a public/pre-session SSE
 * channel is ever built, this should move onto it -- flagged as a known
 * follow-up in docs/initiatives/demo-sandbox-poc-mode.md §3, not silently
 * left as a one-off.
 */
const POLL_INTERVAL_MS = 3000;

export default function LiveDemoContent() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState("");
  const [badFields, setBadFields] = useState<string[]>([]);
  const [company, setCompany] = useState("");
  const pollHandle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = useRef(false);

  useEffect(() => {
    return () => {
      stopped.current = true;
      if (pollHandle.current) clearTimeout(pollHandle.current);
    };
  }, []);

  function startPolling() {
    stopped.current = false;
    const checkOnce = async () => {
      if (stopped.current) return;
      try {
        const res = await fetch("/api/live-demo-signup/claim", { method: "POST" });
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; ready?: boolean; error?: string };
        if (stopped.current) return;
        if (json.ok && json.ready) {
          router.replace("/");
          router.refresh();
          return;
        }
        if (res.status === 401) {
          // The claim link expired (visitor left the tab open too long) —
          // send them back to the form rather than polling forever.
          setError(json.error || "This demo link expired. Please sign up again.");
          setPhase("error");
          return;
        }
        if (!res.ok) {
          // A real, terminal failure (e.g. PROVISIONING_FAILED) — stop
          // polling. Previously any non-401 error status fell through to
          // "schedule the next check", so a permanently-failed tenant spun
          // the UI for the full 30-minute claim-token TTL before showing a
          // misleading "link expired" message instead of the real error.
          setError(json.error || "Something went wrong while setting up your demo. Please try again.");
          setPhase("error");
          return;
        }
        // ready:false / 202 — schedule the next check.
      } catch {
        // Transient network hiccup — schedule the next check, don't
        // surface an error for a single failed poll.
      }
      pollHandle.current = setTimeout(checkOnce, POLL_INTERVAL_MS);
    };
    pollHandle.current = setTimeout(checkOnce, POLL_INTERVAL_MS);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPhase("submitting");
    setError("");
    setBadFields([]);
    const data = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
    setCompany(data.company || "");
    try {
      const res = await fetch("/api/live-demo-signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        ready?: boolean;
        error?: string;
        code?: string;
        details?: { field?: string }[];
      };
      if (!res.ok || !json.ok) {
        if (Array.isArray(json.details)) {
          setBadFields(json.details.map((d) => d.field).filter((f): f is string => !!f));
        }
        if (res.status === 429) {
          setError("You've hit the demo signup limit — please try again in a little while.");
        } else if (res.status === 503) {
          setError("We're at capacity for live demos right now — please try again shortly.");
        } else {
          setError(json.error || "Something went wrong. Please try again.");
        }
        setPhase("error");
        return;
      }
      if (json.ready) {
        router.replace("/");
        router.refresh();
        return;
      }
      // Still provisioning (the normal case) — show the spinner and poll.
      setPhase("provisioning");
      startPolling();
    } catch {
      setError("Couldn't reach the server. Please try again.");
      setPhase("error");
    }
  }

  return (
    <main id="main" className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <DatacernLogo className="size-9" />
          <span className="text-xl font-bold tracking-tight">Datacern AI</span>
        </div>
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              <CardTitle className="text-xl">Try a live demo — no sales call</CardTitle>
            </div>
            <CardDescription>
              We&apos;ll spin up your own governed-decisioning sandbox on synthetic data and log
              you straight in. It expires automatically in a couple of weeks.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {phase === "provisioning" ? (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <Loader2 className="size-8 animate-spin text-primary" />
                <p className="text-sm font-medium">
                  Spinning up {company ? `${company}'s` : "your"} live demo…
                </p>
                <p className="text-xs text-muted-foreground">
                  This usually takes a couple of minutes. We&apos;ll bring you in automatically —
                  no need to refresh.
                </p>
              </div>
            ) : (
              <form onSubmit={onSubmit} className="space-y-3.5">
                {/* honeypot — hidden from real users; bots fill it */}
                <input
                  type="text"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden="true"
                  className="hidden"
                />
                <div className="space-y-1">
                  <Label htmlFor="full_name">Full name</Label>
                  <Input
                    id="full_name"
                    name="full_name"
                    autoComplete="name"
                    required
                    aria-invalid={badFields.includes("full_name")}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="work_email">Work email</Label>
                  <Input
                    id="work_email"
                    name="work_email"
                    type="email"
                    autoComplete="email"
                    required
                    aria-invalid={badFields.includes("work_email")}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    A business email, please — personal/throwaway addresses aren&apos;t accepted.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="company">Company</Label>
                  <Input
                    id="company"
                    name="company"
                    autoComplete="organization"
                    required
                    aria-invalid={badFields.includes("company")}
                  />
                </div>
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
                <Button type="submit" className="w-full" disabled={phase === "submitting"}>
                  {phase === "submitting" ? "Starting your demo…" : "Start my live demo"}
                </Button>
                <p className="text-center text-[11px] text-muted-foreground">
                  This provisions a real, synthetic-data sandbox tenant. No credit card, no sales
                  call — it self-expires.
                </p>
              </form>
            )}
            <div className="mt-4">
              <p className="text-center text-xs text-muted-foreground">
                Prefer a guided tour instead?{" "}
                <Link href="/welcome" className="underline underline-offset-2 hover:text-foreground">
                  See what Datacern AI does
                </Link>
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
