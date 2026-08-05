import type { Metadata } from "next";
import { SECURITY_CONTENT } from "@/content/marketing/security";
import SecurityContent from "./security-content";

/** Public marketing page: security & governance. Lives outside (app) and is
 * listed in the middleware public matcher. Server shell only — content renders
 * from config in the client component. */
export const metadata: Metadata = {
  title: SECURITY_CONTENT.meta.title,
  description: SECURITY_CONTENT.meta.description,
};

export default function SecurityPage() {
  return <SecurityContent />;
}
