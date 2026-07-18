"use client";
import { Database, Warehouse, HardDrive, FolderTree, Cloud, Plug, UploadCloud } from "lucide-react";

/** Category → icon for the connector picker (display only). */
export function CategoryIcon({ category, className }: { category: string; className?: string }) {
  const Icon =
    category === "file-upload"
      ? UploadCloud
      : category === "database"
        ? Database
        : category === "warehouse"
          ? Warehouse
          : category === "object-store"
            ? HardDrive
            : category === "file"
              ? FolderTree
              : category === "saas"
                ? Cloud
                : Plug;
  return <Icon className={className} aria-hidden />;
}

/**
 * Per-connector visual for the data-source picker + list.
 *
 * These are ORIGINAL brand-colored monogram tiles (a colored square + the
 * connector's initials) — deliberately NOT reproductions of the vendors'
 * trademarked logos. They give every source a distinct, recognisable mark
 * without shipping third-party logo artwork.
 *
 * To use a vendor's OFFICIAL logo instead (you have the right to display the
 * marks of the products you integrate with), add the connector's SVG markup to
 * `CONNECTOR_OFFICIAL_SVG[connectorType]` below — it is rendered in place of the
 * monogram automatically. Keep the SVG self-contained (inline paths, no external
 * fetch — the app's CSP blocks remote assets) and sized to fill a square.
 */
type Brand = { short: string; bg: string; fg?: string };

// connector_type -> {monogram, brand-adjacent colour}. Unknown types fall back
// to a category icon tile.
const CONNECTOR_BRAND: Record<string, Brand> = {
  postgres: { short: "Pg", bg: "#336791" },
  mysql: { short: "My", bg: "#00758F" },
  mariadb: { short: "Ma", bg: "#003545" },
  oracle: { short: "Or", bg: "#C74634" },
  sqlserver: { short: "MS", bg: "#A4373A" },
  synapse: { short: "Sy", bg: "#0078D4" },
  presto: { short: "Pr", bg: "#5890FF" },
  bigquery: { short: "BQ", bg: "#4285F4" },
  snowflake: { short: "Sn", bg: "#29B5E8" },
  redshift: { short: "Rs", bg: "#8C4FFF" },
  databricks: { short: "Db", bg: "#FF3621" },
  spanner: { short: "Sp", bg: "#1A73E8" },
  salesforce: { short: "SF", bg: "#00A1E0" },
  s3: { short: "S3", bg: "#E25444" },
  azure_blob: { short: "Az", bg: "#0078D4" },
  gcs: { short: "GC", bg: "#1A73E8" },
  sftp: { short: "SF", bg: "#475569" },
  ftp: { short: "FT", bg: "#64748B" },
  http_api: { short: "{}", bg: "#10B981" },
  file_upload: { short: "⬆", bg: "#6366F1" },
};

// Official inline SVGs go here, keyed by connector_type — rendered instead of
// the monogram when present. Left empty by default (no third-party logo art is
// bundled); the deployer adds the marks they have the right to display.
export const CONNECTOR_OFFICIAL_SVG: Record<string, string> = {};

export function ConnectorLogo({
  connectorType,
  category,
  className,
  size = 20,
}: {
  connectorType: string;
  category?: string;
  className?: string;
  size?: number;
}) {
  const official = CONNECTOR_OFFICIAL_SVG[connectorType];
  if (official) {
    return (
      <span
        role="img"
        aria-label={`${connectorType} logo`}
        className={className}
        style={{ display: "inline-flex", width: size, height: size }}
        // Deployer-provided, self-contained SVG for a vendor the tenant integrates with.
        dangerouslySetInnerHTML={{ __html: official }}
      />
    );
  }
  const brand = CONNECTOR_BRAND[connectorType];
  if (!brand) {
    // Unknown connector: neutral tile with the category glyph.
    return (
      <span
        aria-hidden
        className={className}
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: size, height: size, borderRadius: 6,
          background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))",
        }}
      >
        <CategoryIcon category={category ?? ""} className="size-3.5" />
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={`${connectorType} logo`}
      className={className}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: size, height: size, borderRadius: 6,
        background: brand.bg, color: brand.fg ?? "#fff",
        fontSize: Math.round(size * 0.42), fontWeight: 700, lineHeight: 1,
        letterSpacing: "-0.02em", fontFamily: "var(--font-sans, system-ui)",
      }}
    >
      {brand.short}
    </span>
  );
}
