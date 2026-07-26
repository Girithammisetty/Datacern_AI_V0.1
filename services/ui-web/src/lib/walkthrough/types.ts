/**
 * Guided-walkthrough step schema (BRD 70 DSP-FR-015). Mirrors
 * identity-service's domain.WalkthroughStep 1:1 (services/identity-service/
 * internal/domain/demo.go) and, through it, a bundle's walkthrough.yaml
 * (deploy/demo/<pack>/walkthrough.yaml, §2.2 of docs/initiatives/
 * demo-sandbox-poc-mode.md):
 *
 *   - title: []      title: "Worklist"
 *   - target_route: []  target_route: /cases
 *   - narration: []  narration: "Every pending prior-auth request lands here…"
 *
 * The bundle's own steps are page-level (one route per step, prose
 * narration) — there is no per-element selector or action hint in the
 * shipped format, so the overlay navigates to target_route and shows
 * narration alongside it rather than pointing at a specific DOM node.
 */
export interface WalkthroughStep {
  title: string;
  target_route: string;
  narration: string;
}

export interface WalkthroughResponse {
  steps: WalkthroughStep[];
}
