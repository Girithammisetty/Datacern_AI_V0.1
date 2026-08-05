import type { Metadata } from "next";
import { WALKTHROUGH_CONTENT } from "@/content/marketing/walkthrough";
import WalkthroughContent from "./walkthrough-content";

/**
 * Public marketing subpage: the demo walkthrough. Lives under /welcome so the
 * middleware's public matcher covers it automatically. Server shell only —
 * all copy lives in src/content/marketing/walkthrough.ts and the client
 * component renders it.
 */
export const metadata: Metadata = {
  title: WALKTHROUGH_CONTENT.meta.title,
  description: WALKTHROUGH_CONTENT.meta.description,
};

export default function WalkthroughPage() {
  return <WalkthroughContent />;
}
