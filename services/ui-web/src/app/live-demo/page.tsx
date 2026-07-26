import LiveDemoContent from "./live-demo-content";

/**
 * Public, pre-login self-serve demo signup page (BRD 70 v1.1). The
 * demo-sandbox-poc-mode design's v1 explicitly deferred a public self-serve
 * flow (docs/initiatives/demo-sandbox-poc-mode.md §Out of scope: "Public
 * self-serve demo signup ... explicitly rejected for v1"); this page is
 * that deferred item's v1.1 implementation. Server shell mirrors /welcome's
 * pattern: metadata here, interactive form in the client component.
 */
export const metadata = {
  title: "Try Datacern AI — live demo, no sales call",
  description:
    "Spin up your own live Datacern AI sandbox in minutes. See real governed decisioning on synthetic data — no calendar invite, no operator in the loop.",
};

export default function LiveDemoPage() {
  return <LiveDemoContent />;
}
