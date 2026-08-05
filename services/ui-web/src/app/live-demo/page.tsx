import type { Metadata } from "next";
import { LIVE_DEMO_CONTENT } from "@/content/marketing/live-demo";
import LiveDemoContent from "./live-demo-content";

/**
 * Public, pre-login self-serve demo signup page (BRD 70 v1.1). The
 * demo-sandbox-poc-mode design's v1 explicitly deferred a public self-serve
 * flow (docs/initiatives/demo-sandbox-poc-mode.md §Out of scope: "Public
 * self-serve demo signup ... explicitly rejected for v1"); this page is
 * that deferred item's v1.1 implementation. Server shell mirrors /welcome's
 * pattern: metadata + copy from src/content/marketing/live-demo.ts,
 * interactive form in the client component.
 */
export const metadata: Metadata = {
  title: LIVE_DEMO_CONTENT.meta.title,
  description: LIVE_DEMO_CONTENT.meta.description,
};

export default function LiveDemoPage() {
  return <LiveDemoContent />;
}
