/**
 * Getting-started checklist (ease-of-use initiative) — a role-aware "first ten
 * minutes" on Home.
 *
 * Pure registry: each item carries the SAME capability gate that guards its
 * destination in the nav, so a user is never invited to a step they can't
 * open. The visible list therefore adapts to the persona with no configuration
 * — an analyst sees the casework track, a data steward the data track, an
 * admin the admin track (and whatever else their role reaches).
 *
 * Completion is user-driven (check items off) — the platform never claims a
 * step is "done" without a signal, and the honest cheap signal is the person
 * saying so. State persists client-side per user (see useOnboardingProgress).
 */
import { cap, role, publicGate, ADMIN_ROLE, type Gate } from "@/lib/authz/registry";

export interface ChecklistItem {
  /** Stable key — persisted in localStorage; never rename casually. */
  key: string;
  title: string;
  /** One plain-language line on why this step matters. */
  description: string;
  href: string;
  gate: Gate;
}

export interface ChecklistTrack {
  key: string;
  title: string;
  items: ChecklistItem[];
}

export const CHECKLIST_TRACKS: ChecklistTrack[] = [
  {
    key: "casework",
    title: "Working cases",
    items: [
      {
        key: "open-worklist",
        title: "Open your worklist",
        description: "Your team's queue — the cases waiting on a decision.",
        href: "/cases",
        gate: cap("case.case.read"),
      },
      {
        key: "review-proposal",
        title: "Review an AI proposal",
        description: "Nothing the AI drafts takes effect until a person approves it here.",
        href: "/inbox",
        gate: cap("ai.proposal.read"),
      },
      {
        // Key stays "ask-copilot" — it is persisted in localStorage progress;
        // only the LABEL changed with the Jessie rename.
        key: "ask-copilot",
        title: "Ask Jessie",
        description: "Plain-language answers from your governed data.",
        href: "/copilot",
        gate: publicGate,
      },
      {
        key: "open-dashboards",
        title: "See your dashboards",
        description: "The numbers behind your queue, live.",
        href: "/dashboards",
        gate: cap("chart.dashboard.read"),
      },
    ],
  },
  {
    key: "data",
    title: "Data & AI",
    items: [
      {
        key: "connect-source",
        title: "Connect a data source",
        description: "Link the system your team's data lives in.",
        href: "/data/connections",
        gate: cap("ingestion.connection.read"),
      },
      {
        key: "browse-datasets",
        title: "Browse your datasets",
        description: "Every governed table the platform holds for you.",
        href: "/data",
        gate: cap("dataset.dataset.list"),
      },
      {
        key: "define-vocabulary",
        title: "Define your vocabulary",
        description: "Semantic models make a metric mean the same thing everywhere.",
        href: "/data/semantic-models",
        gate: cap("semantic.model.list"),
      },
    ],
  },
  {
    key: "admin",
    title: "Setting up",
    items: [
      {
        key: "install-pack",
        title: "Install a capability pack",
        description: "Pre-built cases, dashboards and agents for your industry.",
        href: "/packs",
        gate: role(ADMIN_ROLE),
      },
      {
        key: "invite-team",
        title: "Invite your team",
        description: "Each role sees only what it needs.",
        href: "/admin/users",
        gate: role(ADMIN_ROLE),
      },
      {
        key: "set-budgets",
        title: "Set AI budgets",
        description: "Alerts fire as spend passes 80, 95 and 100%.",
        href: "/admin/usage",
        gate: role(ADMIN_ROLE),
      },
    ],
  },
];

/** The universal last step — points at the glossary for everyone. */
export const LEARN_THE_WORDS: ChecklistItem = {
  key: "learn-words",
  title: "Learn the words",
  description: "Two minutes with the glossary and nothing here reads as jargon.",
  href: "/help/glossary",
  gate: publicGate,
};

/**
 * The viewer's checklist: tracks filtered to the items their capabilities
 * reach (a track with no reachable items disappears), plus the universal
 * glossary step appended to the last visible track.
 */
export function visibleTracks(can: (gate: Gate) => boolean): ChecklistTrack[] {
  const tracks = CHECKLIST_TRACKS
    .map((t) => ({ ...t, items: t.items.filter((i) => can(i.gate)) }))
    .filter((t) => t.items.length > 0);
  if (tracks.length > 0) {
    const last = tracks[tracks.length - 1];
    tracks[tracks.length - 1] = { ...last, items: [...last.items, LEARN_THE_WORDS] };
  }
  return tracks;
}
