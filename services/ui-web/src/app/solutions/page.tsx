import type { Metadata } from "next";
import { SOLUTIONS_CONTENT } from "@/content/marketing/solutions";
import SolutionsContent from "./solutions-content";

/** Public marketing page: the pack catalog. Lives outside (app) and is listed
 * in the middleware public matcher. Server shell only — content renders from
 * config in the client component. */
export const metadata: Metadata = {
  title: SOLUTIONS_CONTENT.meta.title,
  description: SOLUTIONS_CONTENT.meta.description,
};

export default function SolutionsPage() {
  return <SolutionsContent />;
}
