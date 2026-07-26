"use client";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCapabilities } from "@/lib/authz/useCapabilities";
import { isEntitlementLocked } from "@/lib/authz/registry";
import { t } from "@/lib/i18n/messages";

/**
 * Locked-feature preview + upsell CTA (BRD 66, CPL-FR-013/030). Distinct from
 * `Can` (lib/authz Gate-driven hide/show for CAPABILITY gates): a commercial
 * `feature` entitlement the tenant's plan doesn't include must render this
 * preview, NEVER be hidden — the whole point is to drive expansion, not to
 * silently disappear like a missing RBAC capability does.
 *
 * The generalized shape here is the one place a locked-pack-style card
 * lives in ui-web today (checked: no pre-existing "locked pack card"
 * component exists yet — pack-service's own install flow doesn't render one
 * either, see services/ui-web/src/app/(app)/packs/page.tsx); this component
 * is written to be the reusable pattern for both packs and any other
 * `feature`-gated surface going forward.
 */
export function EntitlementGate({
  featureKey,
  featureLabel,
  children,
}: {
  /** The commercial `feature` entitlement key (matches a plan's
   * `feature`-kind entitlement key and the BFF's `lockedFeatureKeys`). */
  featureKey: string;
  /** Human-readable name shown in the locked-preview copy (e.g. a pack's
   * display name or a UI feature's label). */
  featureLabel: string;
  children: React.ReactNode;
}) {
  const { set } = useCapabilities();
  const locked = isEntitlementLocked(featureKey, set);
  if (!locked) return <>{children}</>;
  return <LockedFeaturePreview featureLabel={featureLabel}>{children}</LockedFeaturePreview>;
}

/**
 * The visual locked-card itself, exported separately so a caller that
 * already knows the lock state (e.g. a list already holding lockedFeatureKeys,
 * like a pack catalog row) can render it directly without a second
 * useCapabilities() lookup per row.
 */
export function LockedFeaturePreview({
  featureLabel,
  children,
}: {
  featureLabel: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="relative overflow-hidden rounded-lg border border-dashed p-4"
      data-testid="entitlement-locked"
      data-feature={featureLabel}
    >
      {children && (
        <div aria-hidden className="pointer-events-none select-none opacity-40 blur-[1px]">
          {children}
        </div>
      )}
      <div className="mt-3 flex flex-col items-center gap-2 text-center">
        <Lock className="size-5 text-muted-foreground" aria-hidden />
        <div>
          <p className="text-sm font-medium">
            {featureLabel} — {t("state.featureLocked")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{t("state.featureLockedHint")}</p>
        </div>
        <Button size="sm" variant="outline" disabled data-testid="entitlement-upgrade-cta">
          {t("action.upgradePlan")}
        </Button>
      </div>
    </div>
  );
}
