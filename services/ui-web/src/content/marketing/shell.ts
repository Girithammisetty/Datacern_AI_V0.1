/** Shared chrome for every pre-login marketing page: product name, the nav
 * links, the live-demo CTA and the footer lines. One source — the shell
 * component and any bespoke page headers/footers all render from here, so the
 * chrome can never disagree between pages. */

export const MARKETING_SHELL = {
  product: "Datacern AI",

  nav: [
    { label: "Overview", href: "/welcome" },
    { label: "Solutions", href: "/solutions" },
    { label: "Security", href: "/security" },
    { label: "Pricing", href: "/pricing" },
  ],

  signIn: { label: "Sign in", href: "/login" },

  liveDemoCta: { label: "Live demo", href: "/live-demo" },

  footer: {
    left: "Datacern AI — governed AI for regulated operations",
    right: "AI proposes. A named person approves. The platform remembers.",
  },
} as const;

export type MarketingNavHref = (typeof MARKETING_SHELL.nav)[number]["href"];
