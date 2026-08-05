#!/usr/bin/env python3
"""Generate the marketing pack catalog FROM the real pack manifests.

The /solutions page must never drift from what actually ships, so its data is
not hand-written marketing copy: it is derived from `packs/*/pack.yaml` — the
same single-source-of-truth philosophy as ci.yml deriving its matrices from
deploy/services.yaml. Blurbs are the manifest description's own headline (the
text before its first colon), so the page can only claim what a pack's manifest
claims.

Usage:
  python3 tools/marketing/gen_pack_catalog.py           # write packs.gen.ts
  python3 tools/marketing/gen_pack_catalog.py --check   # exit 1 on drift (CI)

Curation that IS allowed to live here (reviewed in this file, not scattered in
TSX): the display title per pack and the industry grouping — labels, not
claims.
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
PACKS = ROOT / "packs"
OUT = ROOT / "services/ui-web/src/content/marketing/packs.gen.ts"

#: slug -> human display title (labels only; claims come from the manifest).
TITLES: dict[str, str] = {
    "ap-invoice-audit": "AP Invoice Audit",
    "background-screening": "Background Screening",
    "banking-aml": "AML & Financial Crime",
    "benefits-appeals": "Benefits Eligibility & Appeals",
    "card-disputes": "Card Disputes (Issuer)",
    "care-management-medicare": "Medicare Care Management",
    "chargeback-representment": "Chargeback Representment (Merchant)",
    "construction-claims": "Construction Claims",
    "credit-disputes": "Credit-Reporting Disputes (FCRA)",
    "device-complaints": "Device Complaints & MDR",
    "healthcare-provider-rcm": "Provider Revenue Cycle",
    "insurance-claims-payer": "Payer Claims & Prior Auth",
    "investigation-framework": "Investigation Framework",
    "manufacturing-mrb": "Nonconformance & MRB",
    "mortgage-loss-mitigation": "Mortgage Loss Mitigation",
    "payer-fwa-siu": "Payment Integrity (FWA / SIU)",
    "pharmacovigilance": "Pharmacovigilance",
    "pharmacy-benefit-mgmt": "Pharmacy Benefits (PBM)",
    "post-acute-care": "Post-Acute Care",
    "seller-vetting": "Seller Vetting & IP Enforcement",
    "tax-notices": "Tax Notices & Exemptions",
    "trade-compliance": "Customs & Trade Compliance",
    "trucking-claims": "Trucking Claims & Safety",
    "trust-safety-appeals": "Trust & Safety Appeals",
    "underwriting-intake": "Underwriting Intake",
    "utility-inspections": "Utility Inspections",
    "warranty-claims": "Warranty Claims",
    "workers-comp-claims": "Workers' Comp Claims",
}

#: industry group -> member slugs. Grouping is presentation, so it is curated
#: here (one reviewable place) rather than inferred fuzzily from categories.
INDUSTRIES: dict[str, list[str]] = {
    "Healthcare & Life Sciences": [
        "insurance-claims-payer", "payer-fwa-siu", "healthcare-provider-rcm",
        "care-management-medicare", "post-acute-care", "pharmacy-benefit-mgmt",
        "pharmacovigilance", "device-complaints",
    ],
    "Banking, Cards & Fintech": [
        "banking-aml", "card-disputes", "credit-disputes",
        "chargeback-representment", "mortgage-loss-mitigation",
    ],
    "Insurance": [
        "workers-comp-claims", "trucking-claims", "construction-claims",
        "underwriting-intake",
    ],
    "Commerce, Platforms & Trust": [
        "seller-vetting", "trust-safety-appeals", "background-screening",
    ],
    "Manufacturing, Auto & Utilities": [
        "manufacturing-mrb", "warranty-claims", "utility-inspections",
    ],
    "Trade, Tax & Corporate Ops": [
        "trade-compliance", "tax-notices", "ap-invoice-audit",
    ],
    "Public Sector": ["benefits-appeals"],
}

#: packs that are shared foundations, not sellable solutions.
LIBRARY = {"investigation-framework"}


def blurb_of(description: str) -> str:
    """The manifest description's own headline: text before its first colon.
    Falls back to a word-boundary cut. Never invents copy."""
    head = description.split(":", 1)[0].strip()
    if 40 <= len(head) <= 180:
        return head
    if len(description) <= 180:
        return description.strip()
    cut = description[:177]
    return cut[: cut.rfind(" ")].rstrip(",;") + "…"


def generate() -> str:
    slug_industry = {s: ind for ind, slugs in INDUSTRIES.items() for s in slugs}
    packs = []
    for d in sorted(PACKS.iterdir()):
        mf = d / "pack.yaml"
        if not mf.is_file():
            continue
        m = yaml.safe_load(mf.read_text())
        slug = m["name"]
        kind = "library" if slug in LIBRARY else "solution"
        industry = slug_industry.get(slug)
        if kind == "solution" and industry is None:
            raise SystemExit(f"pack {slug!r} has no industry mapping — add it "
                             f"to INDUSTRIES in {__file__}")
        packs.append({
            "slug": slug,
            "title": TITLES.get(slug, slug),
            "version": str(m.get("version", "")),
            "blurb": blurb_of(m.get("description", "")),
            "categories": list(m.get("categories", [])),
            "regulatory": list(m.get("regulatory", [])),
            "industry": industry or "Foundations",
            "kind": kind,
        })

    missing = {s for slugs in INDUSTRIES.values() for s in slugs} - {p["slug"] for p in packs}
    if missing:
        raise SystemExit(f"INDUSTRIES references packs with no manifest: {sorted(missing)}")

    def ts_str(s: str) -> str:
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'

    lines = [
        "// GENERATED by tools/marketing/gen_pack_catalog.py — DO NOT EDIT.",
        "// Source of truth: packs/*/pack.yaml. Regenerate:",
        "//   python3 tools/marketing/gen_pack_catalog.py",
        "// CI runs --check, so hand-edits and stale copies fail the build.",
        "",
        "export interface MarketingPack {",
        "  slug: string;",
        "  title: string;",
        "  version: string;",
        "  /** The manifest description's own headline — never authored copy. */",
        "  blurb: string;",
        "  categories: string[];",
        "  regulatory: string[];",
        "  industry: string;",
        '  kind: "solution" | "library";',
        "}",
        "",
        "export const MARKETING_PACKS: MarketingPack[] = [",
    ]
    for p in packs:
        lines.append("  {")
        lines.append(f"    slug: {ts_str(p['slug'])},")
        lines.append(f"    title: {ts_str(p['title'])},")
        lines.append(f"    version: {ts_str(p['version'])},")
        lines.append(f"    blurb: {ts_str(p['blurb'])},")
        lines.append(f"    categories: [{', '.join(ts_str(c) for c in p['categories'])}],")
        lines.append(f"    regulatory: [{', '.join(ts_str(r) for r in p['regulatory'])}],")
        lines.append(f"    industry: {ts_str(p['industry'])},")
        lines.append(f"    kind: {ts_str(p['kind'])},")
        lines.append("  },")
    lines.append("];")
    lines.append("")
    lines.append("/** Industry display order — mirrors the generator's curation. */")
    lines.append("export const PACK_INDUSTRIES: string[] = [")
    for ind in INDUSTRIES:
        lines.append(f"  {ts_str(ind)},")
    lines.append("];")
    lines.append("")
    lines.append("export const SOLUTION_PACK_COUNT: number = "
                 f"{sum(1 for p in packs if p['kind'] == 'solution')};")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    content = generate()
    if "--check" in sys.argv:
        current = OUT.read_text() if OUT.exists() else ""
        if current != content:
            print(f"DRIFT: {OUT} is stale relative to packs/*/pack.yaml — "
                  "run tools/marketing/gen_pack_catalog.py and commit.")
            return 1
        print("pack catalog in sync with manifests")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(content)
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
