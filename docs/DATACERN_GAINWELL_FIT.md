# Datacern ↔ Gainwell-shaped Medicaid data estate — fit analysis

**Researched:** 2026-08-01. **Subject:** [gainwelltechnologies.com/solutions/data-analytics](https://www.gainwelltechnologies.com/solutions/data-analytics/)
**Question:** what must Datacern extend to connect to their existing data sources?

**Rule of this document:** Gainwell facts are from public sources, cited. Datacern facts are from reading the code on 2026-08-01, cited by path. Where the page was unreachable (HTTP 403 to automated fetch), the claim comes from search-indexed content and is marked as such. Effort sizes are **relative, unscoped** — do not quote them as estimates.

---

## 1 · What Gainwell Genius is

Sourced, not assumed:

| Fact | Source |
|---|---|
| **Gainwell Genius™ is built on Databricks Lakehouse architecture** | search-indexed Gainwell content |
| Serves **52 State Medicaid programs** | Gainwell site |
| **Analytics Workbench** — self-service reporting + data science toolkit | Gainwell site |
| **AI-Powered Modeling** — predictive analytics / ML | Gainwell site |
| **Enterprise Reporting: T-MSIS, HEDIS**, compliance reporting | Gainwell site |
| **Fraud detection powered by machine learning** for waste and abuse | Gainwell site |
| **Enterprise Data Warehouse (EDW)** — cloud, master data management, BI | Gainwell site |
| Product lines: Managed Care, Operational Analytics, HEDIS, T-MSIS, EDW, Provider, Pharmacy | search-indexed |
| Claims & Encounters Analytics: MCO analytics, HEDIS/quality, clinical risk profiles, ED utilisation, **third-party liability**, value-based payments | search-indexed |
| **Gainwell Enterprise™** — claims, encounters, financials · **Gainwell Connect** — interoperability / systems integration | Gainwell site |
| Databricks publishes a Gainwell customer story on AWS | databricks.com |

**Read of their position:** Gainwell is the *analytics and reporting* layer over a Medicaid data estate — warehouse, dashboards, compliance submissions, and ML scoring. Their fraud detection **produces a score**. What the public material does not describe is a **governed case-level decision layer**: who acted on the score, on what evidence, who approved it, and whether that is auditable.

That is the seam. **They score. Datacern governs the decision that follows the score.**

---

## 2 · What already connects — verified in code

### 2.1 The headline: the Databricks connector is real

This is the single most important finding, because Genius runs on Databricks.

```python
# services/ingestion-service/app/domain/drivers/databricks.py
from databricks import sql as dbsql   # real SDK, lazily imported on the runtime path
kwargs = {"server_hostname":…, "http_path":…, "access_token":…, "_socket_timeout":…}
if config.catalog: kwargs["catalog"] = config.catalog   # Unity Catalog aware
if config.schema:  kwargs["schema"]  = config.schema
```

- `databricks-sql-connector>=3.4` is a **declared dependency** (`pyproject.toml:47`) — not a schema-only entry
- **Catalog + schema aware**, so Unity Catalog three-part names are addressable
- Registered in the driver dispatch table (`drivers/__init__.py:60,123,195`)
- **Incremental pull via watermark**, bound out-of-band as `%(watermark)s` (pyformat)

⚠️ **Its own docstring is honest and you must repeat it:** *"credential-gated: the adapter is real but a live pull needs a Databricks workspace + SQL warehouse token."* It has **never been run against a real workspace.** Say that before their engineer asks.

### 2.2 Connector and format surface

| Layer | Verified state | Path |
|---|---|---|
| Connector types | **19**: `databricks` · `snowflake` · `redshift` · `bigquery` · `synapse` · `presto` · `postgres` · `mysql` · `mariadb` · `oracle` · `sqlserver` · `spanner` · `s3` · `azure_blob` · `gcs` · `sftp` · `ftp` · `http_api` · `salesforce` | `domain/connectors.py` |
| Driver modules | **17** implemented | `domain/drivers/` |
| Ingestion modes | `file_upload` · `query` · `file_poll` · `scheduled_run` · `webhook_batch` | `api/schemas.py:72` |
| File formats | csv · tsv · json · jsonl · parquet · avro · xml | `connectors.py` `FileFormat` |
| **X12** | **270, 271, 276, 277, 834, 835, 837, 999, TA1** — eligibility, claim status, enrolment, remittance, claims, ACKs | `domain/x12.py`, `x12_control.py`, `x12_out.py` |
| FHIR / HL7v2 / XML standards | Decoders built | `domain/{fhir,hl7v2,xml_standards}.py` |
| Secrets | Separated from config; typed schemas reject unknown fields (`extra="forbid"`) | `connectors.py` |
| Incremental | Watermark state machine | `domain/watermark.py`, `state_machine.py` |

**The X12 set is the Medicaid-relevant one.** 837 (claims/encounters), 835 (remittance), 834 (enrolment), 270/271 (eligibility), 276/277 (claim status) — that is most of the wire traffic a state Medicaid programme runs on.

### 2.3 Packs that already target this estate

Of 9 healthcare/life-sciences packs, four map directly onto Gainwell product lines:

| Datacern pack | Gainwell line it sits behind |
|---|---|
| `payer-fwa-siu` | **Fraud detection** — turns an ML score into a governed SIU investigation case |
| `pharmacy-benefit-mgmt` | **Pharmacy analytics** — PBM / Part D |
| `insurance-claims-payer` | **Claims & encounters** — prior auth, appeals, denials |
| `healthcare-provider-rcm` | **Provider analytics** — revenue cycle, denials |

`payer-fwa-siu` is the sharpest demo for this account: Gainwell's ML flags waste and abuse; Datacern's pack is the governed investigation workflow that has to happen next.

---

## 3 · What does not connect — verified absent

Measured by repo-wide search, 2026-08-01. These are **zero-file** results, not weak coverage.

| Gap | Files | Why it matters here |
|---|---|---|
| **T-MSIS** | **0** | The federal Medicaid submission standard. Gainwell sells T-MSIS reporting as a product line to 52 state programmes. No layout, no validator, no submission format. |
| **HEDIS** | **0** | A named Gainwell product line and a named analytics offering. No measure definitions, no quality-measure model. |
| **CMS-64** | **0** | Federal expenditure reporting. Absent. |
| **NCPDP** | vocabulary only | Appears as domain terminology inside the `pharmacy-benefit-mgmt` pack — **no parser**. The pharmacy claim standard is not decodable. |
| **MMIS** | **0** | Confirmed substring noise on first pass; no MMIS integration concept exists. |
| **Delta Lake / Unity Catalog native** | — | Reads go through the SQL warehouse (JDBC-style query pull). No direct Delta table read, no Delta **write-back**. Datacern's own lakehouse is Iceberg. |
| **MCP client** | — | Per `docs/DATACERN_MCP_CONNECTIVITY.md`: Datacern is an MCP *server*, not a client. It cannot consume a third-party MCP tool surface. |
| **Live-verified DB pulls** | — | Every SQL driver is credential-gated and has **never** pulled from a real warehouse. The adapters are real; the runs are not. |

---

## 4 · What to build — prioritised

Sizes are **relative and unscoped**. Do not present them as estimates.

### Tier 1 — required for a credible Medicaid conversation

1. **Prove the Databricks pull for real.** *(smallest, highest value)*
   The adapter exists; nobody has pointed it at a workspace. One Databricks SQL warehouse, one Unity Catalog table, one watermark-incremental pull, recorded. This converts your strongest claim from "written" to "demonstrated" and costs almost nothing.

2. **T-MSIS file layouts + validator.**
   The single biggest domain gap. Fixed-width/pipe segment layouts, referential validation, submission packaging. This is well-bounded, spec-driven work — exactly the shape their offshore team is good at, which makes it a natural first SOW rather than something you must fund.

3. **NCPDP decoder.**
   Sits alongside the existing X12 decoders and reuses their harness. Unlocks the pharmacy line, where the `pharmacy-benefit-mgmt` pack already has the domain model but cannot read the wire format.

### Tier 2 — deepens the fit

4. **HEDIS measure model** — a pack-level asset (measure definitions, numerator/denominator logic) rather than platform code, so it fits the pack authoring framework.
5. **Delta Lake write-back** — today decisions leave via DB upsert / HTTP post. Writing governed outcomes back into their Delta estate closes the loop into their warehouse.
6. **MCP client adapter** — a second `BackendInvoker` speaking JSON-RPC outward (see `DATACERN_MCP_CONNECTIVITY.md` §2). Lets Datacern consume tool surfaces that Gainwell or their partners expose.

### Tier 3 — only if the relationship is real

7. **CMS-64 expenditure reporting.**
8. **A Gainwell-shaped reference connector profile** — a `connection_template` bundle for the Genius estate, so a new state programme is configuration, not integration work.

**Do not build any of this speculatively.** Every item is scoped, spec-driven work; each one is a better *SOW for their offshore team* than a solo build. That is the point — the gap list is the work order.

---

## 5 · The strategic read

**Do not position against Gainwell's analytics.** They have 52 state programmes, an EDW, a Databricks lakehouse and a mature reporting product line. You will not out-analytics them and should not try.

Position on the seam they don't describe:

> "Your models flag the claim. What happens next is a person deciding — and today that decision is where the audit trail stops. I govern that decision: evidence, proposer, approver, effect, on a tamper-evident record. Your score becomes a case; the case becomes a defensible outcome; the outcome becomes training data that improves your next score."

The three facts that make it land, in order:

1. **Their platform is Databricks; my Databricks connector is real and dependency-backed** — with the honest rider that it has never run live.
2. **The X12 set they run on is already decoded** — 837, 835, 834, 270/271, 276/277.
3. **`payer-fwa-siu` is the governed workflow behind their fraud-detection product**, already built.

And the honest opener, which is what buys the rest:

> "T-MSIS, HEDIS, CMS-64 and NCPDP are not in my platform at all. Those are the four things I'd need to build for a Medicaid programme, and they're spec-driven work — the kind your offshore team does better than I do alone."

---

## 6 · Open question before this is actionable

**Who is Gainwell in this deal?** The recommendation changes materially:

| If Gainwell is… | Then the work is… |
|---|---|
| **A target account** for you directly | Tier 1 items 1–2 are prerequisites; you need a HIPAA/BAA story before any real data moves |
| **A customer of the voice-AI company** you're pitching | Build nothing yet. Use this as evidence you understand their customers' estate — that is worth more in the meeting than any connector |
| **A partner/integration target** | Tier 2 item 6 (MCP client) rises sharply; the seam becomes tool-level, not file-level |
| **A competitor to position against** | Do not compete on analytics. §5's seam framing is the whole answer |

Tell me which, and I'll turn the relevant tier into scoped work.

---

## Do-not-say

- ❌ "We support T-MSIS / HEDIS / CMS-64 / NCPDP" → **all four are zero-file.**
- ❌ "We're integrated with Databricks" → the adapter is real; it has **never run against a live workspace.** Say "built, credential-gated, unproven live."
- ❌ "We read Delta Lake" → reads go via the SQL warehouse. No native Delta read, no Delta write-back.
- ❌ "We can plug into their MCP tools" → no MCP client exists.
- ❌ Any effort estimate from §4. The sizes are relative and unscoped.

---

## Sources

- [Medicaid Data Analytics Solutions | Gainwell Genius Platform](https://www.gainwelltechnologies.com/solutions/data-analytics/)
- [Analytics — Gainwell Technologies](https://discover.gainwelltechnologies.com/analytics/)
- [Gainwell Speeds Medicaid Insights With AI | Databricks](https://www.databricks.com/customers/gainwell-technologies/aws)
- [Medicaid Enterprise Systems | Gainwell](https://www.gainwelltechnologies.com/solutions/medicaid-enterprise/)
- [Healthcare Interoperability & Systems Integration | Gainwell Connect](https://www.gainwelltechnologies.com/solutions/systems-integration-interoperability/)
- [The Role of Analytics in the Future of HEDIS — Gainwell](https://www.gainwelltechnologies.com/resources/blogs/the-role-of-analytics-in-the-future-of-hedis-a-medicaid-perspective/)

*Both Gainwell pages returned HTTP 403 to automated fetch; their content here is from search-indexed summaries and is marked as such in §1.*
