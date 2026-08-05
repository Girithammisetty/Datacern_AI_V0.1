/** /live-demo page content — ALL user-facing copy lives here, the page only
 * renders it. The signup flow logic (submit, provisioning poll, claim) stays
 * in the component; every string a visitor reads comes from this module. */

export const LIVE_DEMO_CONTENT = {
  meta: {
    title: "Try Datacern AI — live demo, no sales call",
    description:
      "Spin up your own live Datacern AI sandbox in minutes. See real governed decisioning on synthetic data — no calendar invite, no operator in the loop.",
  },

  card: {
    title: "Try a live demo — no sales call",
    description:
      "We'll spin up your own governed-decisioning sandbox on synthetic data and log you straight in. It expires automatically in a couple of weeks.",
  },

  form: {
    fullName: "Full name",
    workEmail: "Work email",
    emailNote: "A business email, please — personal/throwaway addresses aren't accepted.",
    company: "Company",
    submit: "Start my live demo",
    submitting: "Starting your demo…",
    footnote:
      "This provisions a real, synthetic-data sandbox tenant. No credit card, no sales call — it self-expires.",
  },

  provisioning: {
    /* {company} is replaced with "<company>'s" or "your" at render time */
    title: "Spinning up {company} live demo…",
    body: "This usually takes a couple of minutes. We'll bring you in automatically — no need to refresh.",
  },

  errors: {
    rateLimited: "You've hit the demo signup limit — please try again in a little while.",
    capacity: "We're at capacity for live demos right now — please try again shortly.",
    expired: "This demo link expired. Please sign up again.",
    provisioning: "Something went wrong while setting up your demo. Please try again.",
    generic: "Something went wrong. Please try again.",
    network: "Couldn't reach the server. Please try again.",
  },

  guidedTour: {
    lead: "Prefer a guided tour instead?",
    label: "See what Datacern AI does",
    href: "/welcome",
  },
} as const;
