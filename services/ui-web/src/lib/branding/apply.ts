import type { TenantBranding } from "@/lib/graphql/types";

/**
 * Applies (or clears) a tenant's brand color tokens as CSS custom properties
 * on <html> (BRD 59 WS3). primaryColor/accentColor are already bare HSL
 * triplets ("221 83% 53%") in the exact shape globals.css's --primary/--accent
 * expect -- no client-side color-space conversion needed. Shared between the
 * app shell (AppShell.tsx) and the embed surfaces (useEmbedFrame.ts) so both
 * apply the SAME brand the same way.
 */
export function applyBrandingTokens(branding: Pick<TenantBranding, "primaryColor" | "accentColor"> | undefined): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement.style;
  if (branding?.primaryColor) root.setProperty("--primary", branding.primaryColor);
  else root.removeProperty("--primary");
  if (branding?.accentColor) root.setProperty("--accent", branding.accentColor);
  else root.removeProperty("--accent");
}
