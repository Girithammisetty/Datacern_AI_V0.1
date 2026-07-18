"use client";
import Link from "next/link";
import { Users, UsersRound, Boxes, Building2, KeyRound, KeySquare, ScrollText, Archive, Wallet, ShieldCheck, Siren, Brain, Router, Wrench, BellRing, ArrowLeftRight, Blocks, Globe } from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/primitives";
import { useCapabilities } from "@/lib/authz/useCapabilities";
import { role, platformGate, ADMIN_ROLE, type Gate } from "@/lib/authz/registry";

const ADMIN: Gate = role(ADMIN_ROLE);

// Admin surfaces grouped into sections. TENANT-admin sections use the per-tenant
// Admin gate; the PLATFORM section is cross-tenant and gated on the first-class
// platform-operator flag — a mere tenant admin never sees it.
type AdminLink = { href: string; title: string; description: string; icon: typeof Users; gate: Gate };
const SECTIONS: { title: string; links: AdminLink[] }[] = [
  {
    title: "Access & identity",
    links: [
      { href: "/admin/users", title: "Users", description: "Invite, deactivate, and role summary per user.", icon: Users, gate: ADMIN },
      { href: "/admin/groups", title: "Groups", description: "Group CRUD, permission matrix, content grants.", icon: ShieldCheck, gate: ADMIN },
      { href: "/admin/teams", title: "Teams", description: "Team CRUD and membership.", icon: UsersRound, gate: ADMIN },
      { href: "/admin/roles", title: "Roles", description: "Custom role CRUD and action sets; system roles are immutable.", icon: KeySquare, gate: ADMIN },
      { href: "/admin/workspaces", title: "Workspaces", description: "Workspace CRUD, custom fields, member roles.", icon: Boxes, gate: ADMIN },
      { href: "/admin/service-accounts", title: "Service accounts", description: "Machine principals (identity-service).", icon: KeyRound, gate: ADMIN },
    ],
  },
  {
    title: "AI & agents",
    links: [
      { href: "/admin/agents", title: "Agents & kill switches", description: "Agent catalog, per-tenant agent config, and emergency stop for a live agent or tool.", icon: Siren, gate: ADMIN },
      { href: "/admin/memory", title: "Agent memory", description: "Browse agent memory and process right-to-be-forgotten requests.", icon: Brain, gate: ADMIN },
    ],
  },
  {
    title: "Operations",
    links: [
      { href: "/admin/usage", title: "Usage & budgets", description: "AI cost panel, budgets, and rate card.", icon: Wallet, gate: ADMIN },
      { href: "/admin/notifications", title: "Notification settings", description: "Subscription rules, webhooks, templates, and delivery health.", icon: BellRing, gate: ADMIN },
      { href: "/admin/writebacks", title: "Decision write-backs", description: "Governed sync of platform decisions to a tenant's system of record.", icon: ArrowLeftRight, gate: ADMIN },
      { href: "/admin/audit", title: "Audit search", description: "Search the audit log with dual-attribution.", icon: ScrollText, gate: ADMIN },
      { href: "/admin/tenant", title: "Tenant settings", description: "Tenant profile, provisioning status, isolation tier.", icon: Building2, gate: ADMIN },
      { href: "/packs", title: "Capability packs", description: "Install a full vertical solution as one governed, reversible bundle.", icon: Blocks, gate: ADMIN },
      { href: "/admin/archive", title: "Archive", description: "Soft-deleted resources and restore.", icon: Archive, gate: ADMIN },
    ],
  },
  {
    // Cross-tenant operator surfaces — platform admins only (not tenant admins).
    title: "Platform administration",
    links: [
      { href: "/admin/tenants", title: "Tenants", description: "Every tenant on the platform (read-only).", icon: Globe, gate: platformGate },
      { href: "/admin/ai-gateway", title: "AI gateway", description: "LLM provider catalog, routing ladders, platform budgets, virtual keys, guardrails.", icon: Router, gate: platformGate },
      { href: "/admin/tools", title: "Tool registry", description: "Tool catalog lifecycle, tenant enablement, and BYO onboarding.", icon: Wrench, gate: platformGate },
    ],
  },
];

export default function AdminHomePage() {
  const { can } = useCapabilities();
  // Show only cards the viewer can reach; drop sections that end up empty (so a
  // pure platform admin sees only the Platform section, a tenant admin never
  // sees it).
  const sections = SECTIONS.map((s) => ({ ...s, links: s.links.filter((l) => can(l.gate)) })).filter(
    (s) => s.links.length > 0,
  );

  return (
    <div>
      <PageHeader title="Administration" description="Access management, tenant settings, usage, and audit." />
      <div className="space-y-8">
        {sections.map((section) => (
          <section key={section.title}>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
              {section.title}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {section.links.map(({ href, title, description, icon: Icon }) => (
                <Link key={href} href={href} className="focus-visible:outline-none">
                  <Card className="h-full transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-primary">
                    <CardHeader>
                      <div className="mb-1 text-muted-foreground">
                        <Icon className="size-5" aria-hidden />
                      </div>
                      <CardTitle className="text-base">{title}</CardTitle>
                      <CardDescription>{description}</CardDescription>
                    </CardHeader>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
