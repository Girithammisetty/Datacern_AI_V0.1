/**
 * Shared between POST /api/live-demo-signup and POST /api/live-demo-signup/claim
 * (BRD 70 v1.1). Kept in its own module rather than exported from route.ts:
 * Next.js Route Handlers only recognize a fixed export surface (GET/POST/...
 * plus a few config vars) on a route.ts file, so a plain constant needs its
 * own file to avoid tripping that check.
 */

/** httpOnly, path-scoped ("/api/live-demo-signup") cookie carrying the
 * short-lived claim_token (domain.TypDemoClaim, identity-service) while a
 * self-serve demo tenant is still provisioning. Never exposed to client JS. */
export const DEMO_CLAIM_COOKIE = "wr_demo_claim";
