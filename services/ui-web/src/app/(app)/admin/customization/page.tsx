"use client";
import Link from "next/link";
import {
  Blocks, Siren, TableProperties, LineChart, KeySquare, Network, Palette, Frame, Fingerprint,
} from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { Card, CardHeader, CardTitle, CardDescription, Badge } from "@/components/ui/primitives";
import { useCapabilities } from "@/lib/authz/useCapabilities";
import { cap, role, ADMIN_ROLE, type Gate } from "@/lib/authz/registry";
import { useSession } from "@/lib/session/SessionContext";
import {
  usePacks, usePackInstalls, useAgentDefinitions, useDecisionModels, useSemanticModelList,
  useRoles, useOntologyEntities, useTenantLabels, useTenant, useTenantIdp,
} from "@/lib/graphql/hooks";

/**
 * BRD 59 WS1 — a single "Customization" surface. Every lever's backend + editor
 * page already exists (pack install, custom agents, decision tables, semantic
 * models, RBAC role clone, ontology, white-label labels, embed, BYO-OIDC); this
 * hub only composes their already-fetched status into one discoverable place
 * and deep-links to the real editors — no new mutations, no logic duplication.
 */

type Lever = {
  href: string;
  title: string;
  description: string;
  icon: typeof Blocks;
  gate: Gate;
  status: React.ReactNode;
};

function CountBadge({ n, suffix = "", zeroLabel = "none" }: { n: number; suffix?: string; zeroLabel?: string }) {
  return (
    <Badge variant={n ? "success" : "secondary"}>
      {n ? `${n}${suffix}` : zeroLabel}
    </Badge>
  );
}

export default function CustomizationHubPage() {
  const { can } = useCapabilities();
  const { tenantId, workspaceId } = useSession();

  const packs = usePacks();
  const installs = usePackInstalls(workspaceId);
  const agents = useAgentDefinitions();
  const decisions = useDecisionModels();
  const semanticModels = useSemanticModelList(workspaceId);
  const roles = useRoles();
  const ontology = useOntologyEntities(workspaceId);
  const labels = useTenantLabels();
  const tenant = useTenant(tenantId);
  const idp = useTenantIdp();

  // Free client-side "upgrade available" check: compare each live install's
  // version against the catalog's current version for that pack name. No new
  // backend call — packDrift (the deeper structural check) stays an on-demand
  // action on the Packs page itself, not eager-fetched per install here.
  const installedPacks = (installs.data ?? []).filter((i) => i.status !== "uninstalled");
  const catalogByName = new Map((packs.data ?? []).map((p) => [p.name, p]));
  const upgradeCount = installedPacks.filter((i) => {
    const latest = catalogByName.get(i.pack);
    return latest && latest.version !== i.version;
  }).length;

  const roleRows = roles.data?.pages.flatMap((p) => p.nodes) ?? [];
  const customRoleCount = roleRows.filter((r) => !r.system).length;
  const rolesHasMore = roles.hasNextPage === true;

  const semanticRows = semanticModels.data?.pages.flatMap((p) => p.nodes) ?? [];
  const semanticHasMore = semanticModels.hasNextPage === true;

  const embed = tenant.data?.embedConfig;
  const idpCfg = idp.data;

  const LEVERS: Lever[] = [
    {
      href: "/packs", title: "Capability packs", icon: Blocks, gate: cap("pack.pack.read"),
      description: "Install a governed vertical solution; upgrade, roll back, or check drift.",
      status: (
        <div className="flex items-center gap-1.5">
          <CountBadge n={installedPacks.length} suffix=" installed" zeroLabel="none installed" />
          {upgradeCount > 0 && <Badge variant="warning">{upgradeCount} upgrade{upgradeCount === 1 ? "" : "s"} available</Badge>}
        </div>
      ),
    },
    {
      href: "/admin/agents", title: "Custom agents & guardrails", icon: Siren, gate: role(ADMIN_ROLE),
      description: "Configure per-tenant agent behavior, tools, and guardrail envelopes.",
      status: <CountBadge n={agents.data?.length ?? 0} suffix=" configured" />,
    },
    {
      href: "/decisions", title: "Decision tables", icon: TableProperties, gate: cap("case.disposition.read"),
      description: "Governed rule tables driving automated dispositions.",
      status: <CountBadge n={decisions.data?.length ?? 0} />,
    },
    {
      href: "/data/semantic-models", title: "Semantic models", icon: LineChart, gate: cap("semantic.model.list"),
      description: "Dimensions and measures that power charts and dashboards.",
      status: <CountBadge n={semanticRows.length} suffix={semanticHasMore ? "+" : ""} />,
    },
    {
      href: "/admin/roles", title: "Custom roles", icon: KeySquare, gate: role(ADMIN_ROLE),
      description: "Clone and customize a role's action set beyond the system defaults.",
      status: <CountBadge n={customRoleCount} suffix={rolesHasMore ? "+" : ""} zeroLabel="none custom" />,
    },
    {
      href: "/data/ontology", title: "Ontology", icon: Network, gate: cap("dataset.ontology.read"),
      description: "The governed entity-type registry behind case grounding and agent reasoning.",
      status: <CountBadge n={ontology.data?.length ?? 0} suffix=" entity types" />,
    },
    {
      href: "/admin/tenant", title: "Display labels", icon: Palette, gate: role(ADMIN_ROLE),
      description: "Rename product vocabulary (e.g. \"Cases\" → \"AP Exceptions\") tenant-wide.",
      status: <CountBadge n={labels.data?.length ?? 0} suffix=" override(s)" />,
    },
    {
      href: "/admin/tenant", title: "Embedding", icon: Frame, gate: role(ADMIN_ROLE),
      description: "Allow partner sites to iframe this tenant's dashboards, cases, and copilot.",
      status: <Badge variant={embed?.configured ? "success" : "secondary"}>{embed?.configured ? "configured" : "not configured"}</Badge>,
    },
    {
      href: "/admin/tenant", title: "Single sign-on (BYO-OIDC)", icon: Fingerprint, gate: role(ADMIN_ROLE),
      description: "Bring your own identity provider so users sign in against your IdP.",
      status: (
        <Badge variant={idpCfg?.configured && idpCfg?.enabled ? "success" : "secondary"}>
          {idpCfg?.configured ? (idpCfg?.enabled ? "enabled" : "disabled") : "not configured"}
        </Badge>
      ),
    },
  ];

  const visible = LEVERS.filter((l) => can(l.gate));

  return (
    <div>
      <PageHeader
        title="Customization"
        description="Every self-service lever for shaping this tenant's platform, in one place."
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map(({ href, title, description, icon: Icon, status }) => (
          <Link key={title} href={href} className="focus-visible:outline-none">
            <Card className="h-full transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-primary">
              <CardHeader>
                <div className="mb-1 flex items-center justify-between">
                  <Icon className="size-5 text-muted-foreground" aria-hidden />
                </div>
                <CardTitle className="text-base">{title}</CardTitle>
                <CardDescription>{description}</CardDescription>
                <div className="pt-2">{status}</div>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
