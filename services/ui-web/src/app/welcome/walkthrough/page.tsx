import type { Metadata } from "next";
import WalkthroughContent from "./walkthrough-content";

/**
 * Public marketing subpage: the demo walkthrough. Lives under /welcome so the
 * middleware's public matcher covers it automatically. Server shell only —
 * all content is in the client component.
 */
export const metadata: Metadata = {
  title: "Demo walkthrough — Datacern AI",
  description:
    "Follow one governed decision through Datacern AI, end to end: worklist, copilot triage, four-eyes approval, learning loop, audit trail.",
};

export default function WalkthroughPage() {
  return <WalkthroughContent />;
}
