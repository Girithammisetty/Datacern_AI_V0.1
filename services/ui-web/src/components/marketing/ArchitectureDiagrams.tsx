"use client";

/**
 * Architecture diagram viewer for the pre-login marketing page.
 *
 * The SVGs are generated from the repo's real layout — services/*, packs/*,
 * deploy/terraform/{aws,gcp,azure} and the Helm umbrella chart — not drawn
 * aspirationally (source of truth: docs/architecture/). public/architecture/*
 * are copies of docs/architecture/diagrams/*; regenerate there, then re-copy.
 */

import { useState } from "react";

const DIAGRAMS = [
  {
    key: "layered",
    label: "Platform layers",
    src: "/architecture/layered-architecture.svg",
    alt: "Datacern layered technical architecture — experience, packs, AI/agent, ML, data planes over an open-source backbone, with governance and platform-core rails",
    caption:
      "23 services in five planes, wrapped by the governance rail (four-eyes approvals, signed execution grants, tamper-evident audit) and the platform core (identity, metering, entitlements).",
  },
  {
    key: "aws",
    label: "AWS deployment",
    src: "/architecture/deploy-aws.svg",
    alt: "Datacern deployment architecture on AWS — EKS with RDS, MSK, ElastiCache, S3, OpenSearch, KMS and Secrets Manager",
    caption:
      "EKS + RDS + MSK + ElastiCache + S3 + OpenSearch, provisioned by the Terraform stack shipped in this repository (deploy/terraform/aws) and deployed with one Helm command.",
  },
  {
    key: "gcp",
    label: "GCP deployment",
    src: "/architecture/deploy-gcp.svg",
    alt: "Datacern deployment architecture on Google Cloud — GKE with Cloud SQL, Managed Kafka, Memorystore, GCS, Secret Manager",
    caption:
      "GKE + Cloud SQL + Managed Service for Apache Kafka + Memorystore + GCS, from the shipped Terraform stack (deploy/terraform/gcp). Same services, same Helm chart.",
  },
  {
    key: "azure",
    label: "Azure deployment",
    src: "/architecture/deploy-azure.svg",
    alt: "Datacern deployment architecture on Microsoft Azure — AKS with PostgreSQL Flexible Server, Event Hubs, Azure Cache, Blob Storage, Key Vault",
    caption:
      "AKS + PostgreSQL Flexible Server + Event Hubs (Kafka protocol) + Azure Cache + Blob Storage behind private endpoints, from the shipped Terraform stack (deploy/terraform/azure).",
  },
] as const;

export function ArchitectureDiagrams() {
  const [active, setActive] = useState<(typeof DIAGRAMS)[number]["key"]>("layered");
  const current = DIAGRAMS.find((d) => d.key === active) ?? DIAGRAMS[0];

  return (
    <div>
      <div role="tablist" aria-label="Architecture diagrams" className="flex flex-wrap gap-2">
        {DIAGRAMS.map((d) => (
          <button
            key={d.key}
            role="tab"
            aria-selected={d.key === active}
            onClick={() => setActive(d.key)}
            className={
              d.key === active
                ? "rounded-full border border-primary bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground"
                : "rounded-full border border-border/70 bg-card px-4 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            }
          >
            {d.label}
          </button>
        ))}
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-border/70 bg-white shadow-sm">
        {/* eslint-disable-next-line @next/next/no-img-element -- static local SVG; next/image adds nothing for vector assets */}
        <img src={current.src} alt={current.alt} className="h-auto w-full" loading="lazy" />
      </div>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted-foreground">{current.caption}</p>
        <a
          href={current.src}
          download
          className="shrink-0 rounded-md border border-border/70 bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Download SVG
        </a>
      </div>
    </div>
  );
}
