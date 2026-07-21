# BRD 57 — Standards-Native Interop (EDI X12 · HL7/FHIR · ISO 20022 · ACORD)

**Deliverable type:** Core capability (standards format/semantic layer over the existing ingestion transport + writeback spine)
**Publisher:** Datacern · **Initial version:** 1.0.0 · **Status:** **inc-1 BUILT** (X12 decode spine: STD-FR-010/011 for 837, structural conformance, BR-2/BR-4; `app/domain/x12.py` + `x12` registered in the decoder registry). Remainder DESIGNED — see §8.
**Closes:** the standards-interop gap — Core ships 20 transport drivers but only 5 generic decoders (csv/json/parquet/avro/xml), while BRD 26 (Provider RCM), BRD 27 (Payer FWA/SIU) and the underwriting-intake pack all specify EDI/FHIR/ACORD connectivity at the pack level.

---

## 1. Overview

**Purpose.** Make regulated industry wire formats first-class citizens of the
data plane: read an X12 837 claim, a FHIR `ExplanationOfBenefit`, an ISO 20022
`camt.053` statement or an ACORD application into **governed datasets**, and emit
conformant outbound messages (837 corrected claim, 276 status inquiry, pain.001
payment instruction) through the **existing proposal-mode writeback spine** — so
a machine-readable message to an external party is governed exactly like any
other real-world side effect.

**Why.** Datacern's ingestion layer today is transport-complete and
format-generic. `services/ingestion-service/app/domain/drivers/` provides ~20
connectors (S3, SFTP, FTP, HTTP, Postgres/MySQL/MSSQL/Oracle, Snowflake,
BigQuery, Databricks, Redshift, Salesforce, GCS, Azure Blob …) and
`app/domain/decode.py` decodes csv/json/parquet/avro/xml. That is the right
foundation — and it is exactly half the problem. In the verticals Datacern
targets, the payload arriving over SFTP is **not** a CSV; it is a positional,
loop-structured X12 envelope with its own control numbers, acknowledgement
protocol and companion-guide dialect. Today a pack that needs 837s must either
pre-flatten upstream (losing fidelity and lineage) or re-implement segment
parsing inside pack content.

**The structural argument.** Three shipped BRDs already assume this capability:

- **BRD 26 (Provider RCM)** — reads Epic FHIR R4 + HL7v2, EDI 837/835/276/277/275
  via Waystar/Change/Availity, and defines **seven proposal-mode write adapters**
  including outbound 837 (corrected claim) and 276 (status inquiry).
- **BRD 27 (Payer FWA/SIU)** — reads EDI 837/835 alongside Facets/HealthEdge/QNXT.
- **underwriting-intake pack** — ACORD applications + currently-valued loss runs.

Without a Core layer, each of those re-implements X12 in pack content. That
violates the frozen-Core/packs invariant (BRD 23) in the worst direction:
duplicated parsing logic, per-pack correctness, no shared conformance testing,
and — critically — **outbound** messages assembled outside the governed writeback
path. Standards belong in Core for the same reason RLS and the audit chain do:
they are cross-vertical, correctness-critical, and dangerous to re-implement.

**The scope line (the important architectural call).** Core owns the
**envelope**; packs own the **dialect**.

| Core (this BRD) | Packs |
|---|---|
| Segment/loop grammar, envelope structure, control numbers, acknowledgements, conformance validation, serialization, trading-partner registry | Code sets (CPT/ICD/HCPCS, reason codes), payer companion guides, per-partner field maps, business meaning |

This keeps Core frozen and finite (a bounded set of transaction sets and
resources) while the long tail of partner-specific quirks stays declarative.

**In scope (capability).** A standards decoder registry extending
`decode.py`; a standards serializer feeding the existing writeback spine; control-
number and acknowledgement management; conformance validation surfaced as
governed findings; and a trading-partner registry. Phased by demand (§3).

**Out of scope for v1.** AS2/VAN transport (SFTP + HTTP already exist and cover
most clearinghouse integrations); clearinghouse-proprietary REST APIs (pack-level
connectors); HIPAA/NCPDP certification programs; EHR-vendor app-store listings.

---

## 2. Actors & user stories

- **Integration engineer (tenant)** — "I register our clearinghouse as a trading
  partner with our ISA qualifiers and companion guide, point it at our existing
  SFTP connection, and 837s land as governed dataset rows with lineage back to
  the raw envelope."
- **Claims/RCM analyst** — "I see a claim, its 277CA status and its 835
  remittance line correlated on one case, not three unlinked files."
- **Approver (four-eyes)** — "An outbound corrected 837 is a proposal I approve
  like any other write-back; I can see the exact message that will be
  transmitted before it leaves."
- **Compliance officer** — "Every inbound envelope is retained immutably, every
  outbound transmission is in the audit chain, and rejected messages are visible
  — never silently dropped."
- **Platform operator** — "A transaction set we do not support is refused with a
  typed error at registration time, not half-parsed at 3am."

---

## 3. Functional requirements (summary)

Phasing follows demand from the shipped pack BRDs.

**Phase 1 — X12 EDI (healthcare first; highest volume, most demanded)**
- **STD-FR-010** Decode X12 envelopes (ISA/GS/ST … SE/GE/IEA) into governed rows,
  preserving loop hierarchy and full raw-segment lineage.
- **STD-FR-011** Transaction sets: **837P/837I** (claims), **835** (remittance),
  **834** (enrollment), **270/271** (eligibility), **276/277** (claim status).
- **STD-FR-012** Serialize outbound **837** (corrected claim) and **276** (status
  inquiry) as writeback proposals.
- **STD-FR-013** Control-number management: monotonic ISA/GS/ST assignment per
  trading partner, with persistence and gap detection.
- **STD-FR-014** Acknowledgement handling: **TA1 / 997 / 999** and **277CA**,
  correlated back to the originating transmission.
- **STD-FR-015** Correlation chain: 837 → 277CA → 835 linked as one lifecycle on
  the owning case/dataset row.

**Phase 2 — HL7 FHIR R4 + HL7v2**
- **STD-FR-020** FHIR R4 read via REST with pagination/`_since` incremental sync;
  resources: `Patient`, `Coverage`, `Claim`, `ClaimResponse`,
  `ExplanationOfBenefit`, `Encounter`, `DocumentReference`.
- **STD-FR-021** SMART-on-FHIR / OAuth2 client-credentials auth, credentials via
  the existing `SecretsStore` (BYO-P2), never inline.
- **STD-FR-022** HL7v2 (pipe-delimited) ingest for ADT/ORU where FHIR is absent.

**Phase 3 — ISO 20022 + ACORD**
- **STD-FR-030** ISO 20022 read `camt.052/053/054` (statements) and
  `pacs.002/008`; write `pain.001` (payment initiation) as a writeback proposal.
- **STD-FR-031** ACORD XML (P&C application / loss run) decode for underwriting.

**Cross-cutting**
- **STD-FR-040** **Trading-partner registry**: per-partner identifiers/qualifiers,
  companion-guide profile, transport binding (reusing an existing connection),
  test-vs-production mode, and enable/disable — all tenant-scoped.
- **STD-FR-041** **Conformance validation**: structural (segment/element/loop
  cardinality), code-set, and companion-guide rules; failures become governed
  data-quality findings, not dropped rows.
- **STD-FR-042** **Raw-envelope retention**: every inbound/outbound message
  stored immutably in the object store, addressable from the derived rows.
- **STD-FR-043** Duplicate detection: replayed ISA control numbers rejected.

---

## 4. Business rules

- **BR-1 (governed egress).** Every outbound standards message is a real-world
  side effect and MUST traverse the existing proposal-mode writeback spine with
  four-eyes approval. There is no direct-transmit path. The approver sees the
  rendered message before transmission.
- **BR-2 (no partial parsing — Rule 2).** An unsupported transaction set,
  version, or malformed envelope MUST fail with a typed, non-retryable error and
  land the ingestion run in `failed` with a named reason. Partially decoding an
  envelope into plausible-looking rows is prohibited — it is the fabrication
  failure mode the platform exists to prevent.
- **BR-3 (rejections are first-class).** Negative acknowledgements (TA1/999
  rejects, 277CA denials) MUST surface as governed findings and events. They are
  never swallowed or logged-only.
- **BR-4 (lineage).** Every derived row carries a reference to its raw envelope,
  transaction-set id and control numbers, so any decision is traceable to the
  exact bytes received.
- **BR-5 (PHI/PII).** X12 and FHIR payloads carry PHI. Raw envelopes are
  tenant-scoped under RLS, encrypted at rest, and subject to the existing PII
  egress guardrails; trading-partner credentials live in `SecretsStore`.
- **BR-6 (control-number integrity).** Outbound control numbers are strictly
  monotonic per partner and durable across restarts; a gap or reuse is an
  operational alert, not a silent retry.
- **BR-7 (Core/pack boundary).** Core ships grammar + envelope + acknowledgement
  handling. Code sets, companion guides and partner field maps are pack content.
  Adding a payer must require **zero** Core changes.

---

## 5. Acceptance criteria

- **AC-1** A real 837P fixture ingested over the existing SFTP connector yields
  governed dataset rows with loop structure intact and raw-envelope lineage.
- **AC-2** An 835 fixture correlates to its originating 837 and materializes
  remittance lines on the owning case (STD-FR-015).
- **AC-3** A corrected 837 is emitted only after four-eyes approval; the approver
  sees the exact serialized message; the transmission appears in the audit chain
  (BR-1).
- **AC-4** A structurally invalid envelope produces a typed failure and a governed
  finding — and produces **zero** derived rows (BR-2).
- **AC-5** A replayed ISA control number is rejected as a duplicate (STD-FR-043).
- **AC-6** Outbound control numbers remain monotonic across a service restart
  (BR-6).
- **AC-7** A 999 reject is visible as a finding and correlated to its
  transmission (BR-3).
- **AC-8** Registering an unsupported transaction set fails at registration time
  with a named error (BR-2).
- **AC-9** Adding a new payer companion guide requires only pack content — no
  Core deploy (BR-7).
- **AC-10** FHIR ingest authenticates via `SecretsStore` credentials and performs
  an incremental `_since` sync without full refetch (STD-FR-020/021).

---

## 6. Dependencies

Datacern Core: **ingestion-service** (transport drivers + `decode.py` decoder
registry + the proposal-mode writeback spine), **dataset-service** (governed
datasets/Iceberg + lineage), **object store** (raw-envelope retention),
**audit-service** (transmission trail), **BYO-P2 `SecretsStore`** (partner
credentials), **case-service** (correlation onto cases).

Consumers: **BRD 26** (Provider RCM — the heaviest), **BRD 27** (Payer FWA/SIU),
**underwriting-intake** (ACORD), and any future payments pack (ISO 20022).

External: trading-partner/clearinghouse connectivity (Waystar, Change/Optum,
Availity) and their companion guides; X12 licensing for the specification.

---

## 7. Out of scope / future

- **AS2/VAN transport** — SFTP/HTTP cover most clearinghouses; AS2 (certificates,
  MDN receipts) is a separate transport BRD if a partner mandates it.
- **NCPDP** (pharmacy), **EDIFACT** (non-US), **SWIFT MT** — additive once the
  grammar layer exists.
- **Clearinghouse-proprietary REST APIs** — pack-level connectors, not Core.
- **Certification programs** (HIPAA attestation, EHR app listings) — commercial,
  not engineering.
- **Real-time 270/271 eligibility at point-of-service** — v1 targets batch; the
  synchronous path is a latency-shaped follow-up.

---

## 8. Increment status

**inc-1 — BUILT.** The X12 decode spine, in `services/ingestion-service`:
`app/domain/x12.py` (envelope grammar, self-describing delimiters, streaming
segment tokenizer, 837 claim-loop extraction, structural conformance) plus
`"x12"` registered in the `decode.py` decoder registry. Delivers **STD-FR-010**,
**STD-FR-011 (837)**, part of **STD-FR-041**, and **BR-2 / BR-4**. Covered by 17
unit tests (**AC-1, AC-4, AC-8**), including a mutation check proving the
delimiter handling is genuinely data-driven.

Honest boundaries of inc-1:
- One row per claim (2300). Field extraction is a defensible core set —
  claim id/charge/POS, billing NPI, subscriber id, diagnoses, service-line count
  — with the claim's **raw segments preserved** so nothing is lost to a partial
  mapping. Full 837 element coverage is additive, not a redesign.
- **BR-2's "zero derived rows" is delivered by the runner, not the decoder.**
  Decoding streams, so claims parsed before a terminal envelope error are already
  yielded; `table_writer.stage()` consumes the generator, so a raise means no
  `StagedAppend` and no commit. The decoder's guarantee is that the error is
  always raised, never swallowed. This is pinned by a named test.
- Not yet exercised against a real trading-partner file — fixtures are
  structurally exact but synthetic. First real payer file is where companion-
  guide reality will bite.

**inc-2a — BUILT.** Outbound 837 serialization: `app/domain/x12_out.py`
(`render_837`, `OutboundControl`, `checksum`). Delivers **STD-FR-012**'s render
half. 21 unit tests.

The governance decision, recorded because it is not reversible cheaply:
**rendering happens at PROPOSE time, not at transmit time.** BR-1 requires the
approver to see the exact message that will be transmitted; assembling the
interchange during delivery would let the bytes on the wire differ from the bytes
reviewed, which makes four-eyes approval of an outbound claim meaningless. So the
caller renders, stores the result plus its `checksum`, routes THAT through the
existing four-eyes spine, and transmits the stored bytes verbatim. Accepted
consequence: a rejected proposal burns its control numbers, leaving a gap — BR-6
already treats gaps as an operational alert, and "a human refused this
transmission" is a better audit story than "approved bytes ≠ sent bytes".
`render_837` is therefore a PURE function (control numbers are caller-supplied),
which is what makes the propose-time checksum meaningful.

Verification of note: the round-trip test renders then decodes with the inc-1
decoder, which independently validates SE01 segment counts and every
control-number pairing — so the two halves check each other, and a serializer
off-by-one fails in CI rather than at a trading partner.

**Security finding fixed in this increment — EDI injection.** X12 has NO escape
mechanism, so a delimiter inside a data element is indistinguishable from a real
one: a `~` terminates the segment early and everything after it parses as a NEW
segment. This was verified against the renderer before the guard existed — a
claim id of `GOOD~NM1*85*2*ATTACKER*****XX*9999999999` produced a second
billing-provider NM1 with an attacker-controlled NPI, i.e. **claim forgery that
reroutes payment**. Every caller-supplied value that reaches a segment (claim
fields, service lines, identity fields, control fields) is now delimiter-checked
against the delimiters actually in use, and refused rather than mangled (Rule 2).
Regression-pinned with the exact payload.

**inc-2b — BUILT.** The renderer now rides the governed writeback spine, closing
**BR-1** end to end. Two surgical changes to `writebacks.py` and **no new
governance code** — four-eyes is inherited, exactly as intended:
1. `enqueue()` renders the interchange when `target.format == "x12"` and stores
   the bytes + checksum on the writeback. Because `serialize_writeback` exposes
   `payload`, `GET /writebacks/{id}` shows the approver the **literal message**.
   A claim that cannot be expressed as conformant X12 fails at enqueue and never
   becomes a pending proposal someone could approve.
2. `_deliver_http_post()` transmits those exact bytes with
   `Content-Type: application/edi-x12`, after **re-verifying the checksum**.

That last check is the governance property worth naming: if the stored
interchange is mutated between approval and delivery, the checksum no longer
matches and delivery **refuses** rather than putting bytes on the wire that no
human approved. Pinned by `test_tampering_after_approval_refuses_to_transmit`.
The non-X12 JSON path is untouched (its 6 existing tests still pass).

**inc-3a — BUILT.** 835 remittance decode + the 837↔835 correlation
(STD-FR-011 for 835, **STD-FR-015**). `x12.py` was refactored so the envelope
machinery (ISA/GS/ST..IEA + all control-number conformance) is shared and
row-building is dispatched to a per-transaction-set **handler** (`_ClaimHandler`
for 837, `_RemitHandler` for 835) — adding a transaction set is now a new
handler, not a rewrite. The 47 existing 837/serializer tests were the regression
net and all still pass. 835 yields one row per CLP claim-payment loop with
payer/payee, check/EFT trace, BPR payment, charged/paid/patient-responsibility
and claim-level CAS adjustments; the raw CLP segments are preserved for lineage.
The key column is `claim_id` (CLP01 echoes the submitter's CLM01) — deliberately
the SAME column name as the 837's, so `test_837_and_835_correlate_on_claim_id`
proves the join that turns "we billed" + "they paid" into an underpayment (what
BRD 26's detector proposes on). 7 new tests.

Fixture note worth recording: my first 835 fixture put the payment date at BPR15,
but BPR16 is the effective-entry date per 005010 — the handler was right, the
fixture was one element short. Fixed the fixture, not the parser.

**inc-3b — BUILT.** 271 eligibility-response + 277 claim-status-response decode
(STD-FR-011). Each is a new handler on the shared envelope (`_EligibilityHandler`
2110 EB rows with subscriber + payer context; `_ClaimStatusHandler` 2200 STC rows
keyed on TRN02/REF claim id, which correlates to the 837 like 835 does). The
**inquiry** halves (270/276) are deliberately refused as recognised-but-not-
decoded — the platform SENDS those and ingests the responses. 8 new tests. This
completes the **full healthcare X12 inbound set: 837, 835, 271, 277** — every
read connector BRD 26/27 named except the 275 attachment.

**inc-3c — BUILT.** HL7 FHIR R4 decode (STD-FR-020's decode half). `fhir.py` +
`"fhir"` in the registry. Accepts both a **Bundle** (JSON object with `entry[]`)
and **NDJSON** (FHIR Bulk `$export`), auto-detected. Dispatches by `resourceType`
to a mapper for Patient/Coverage/Claim/ClaimResponse/ExplanationOfBenefit/
Encounter → a generic governed row (resource_type/id/patient_ref/status/
identifier/code/amount/period) with the full raw resource kept for lineage.
Unmapped types are SKIPPED (a Bundle legitimately mixes types — an
OperationOutcome must not become a bogus row nor fail the decode); a resource
with no `resourceType`, or broken JSON, is refused (Rule 2). 12 tests. NOTE: the
REST transport half — paginated `_since` incremental sync + SMART-on-FHIR auth
via SecretsStore (STD-FR-020/021) — is a connector and a separate increment; this
is the decode a file drop or that connector both feed.

**inc-3d — BUILT.** HL7 v2.x decode (STD-FR-022). `hl7v2.py` + `"hl7v2"` in the
registry. Delimiters are read from MSH (field sep = the char after `MSH`, MSH-2
carries component/repetition/subcomponent) — the same data-driven discipline as
X12. Dispatched by message type: ADT emits one patient/event row per message;
ORU emits one row per OBX observation. Tolerates `\r`, `\n` and `\r\n` segment
terminators; a stream not starting with MSH is refused (Rule 2). 9 tests.

**inc-3e — BUILT.** ISO 20022 (STD-FR-030) + ACORD (STD-FR-031) decode.
`xml_standards.py` + `"iso20022"`/`"acord"` in the registry. These are XML, so
they REUSE decode.py's DTD/billion-laughs guard + bounded spool + namespace
stripping — the module adds only semantic mapping, never re-implements XML
parsing and never relaxes the guard (a `test_billion_laughs_dtd_rejected`
confirms the guard is inherited). ISO 20022 camt.05x → one row per `Ntry`
(amount, Cr/Dr, booking/value date, remittance); ACORD → one row per policy
element (number, insured, LOB, dates, premium). A non-conforming root is refused
by name (Rule 2). 7 tests. **This completes every standards family the BRD named:
X12 (837/835/271/277 in + 837 out), FHIR, HL7v2, ISO 20022, ACORD.**

**inc-3f — BUILT.** 834 enrollment/maintenance decode — the last transaction set
on the enumerated list. `_EnrollmentHandler` emits one row per HD coverage line
(member id from REF*0F, name from NM1*IL, INS maintenance type/reason, HD
coverage type + plan, DTP*348/349 benefit begin/end). 5 tests; 997 is now the
recognised-but-not-decoded example (834 was). **Full inbound X12 decode list
done: 837, 835, 271, 277, 834 (270/276 correctly refused as outbound inquiries;
997/999 acks are the transport-remainder).**

Bug found + fixed in this pass (worth recording): the XML find helper used
`_find(...) or parent`, but an ElementTree element with NO children is FALSY —
so the fallback silently mis-scoped AND tripped a DeprecationWarning. Replaced
with explicit `is None` checks (`_sub_text`); the suite now passes under
`-W error::DeprecationWarning`.

**inc-4 — BUILT.** X12 acknowledgements (STD-FR-014), the TA1/999 half of the
Remaining list above. Both close the loop on inc-2's outbound governance: after
Datacern transmits an approved 837, a trading partner's ack tells us whether it
landed.
- **TA1 (interchange-level ack).** Unlike every other X12 shape handled so far,
  TA1 has no ST/SE wrapper — it is a single segment carried directly in an
  interchange, often with no GS at all (a dedicated ack interchange). Handled
  as a special case in `decode_x12`'s dispatch rather than a `_HANDLERS` entry:
  it flushes whatever row schema is already in flight first (so one batch never
  mixes two shapes), then yields its own single-row batch. One row: acked
  interchange control number/date/time, ack code (A/E/R), note code.
- **999 (implementation acknowledgment).** Fits the existing envelope/handler
  pattern exactly — it is itself carried in an ISA/GS/ST..SE/GE/IEA envelope
  (GS01=`FA`) — so `_AckHandler` is a new `_HANDLERS` entry, not new plumbing.
  One row per acknowledged transaction set (an AK2/AK5 pair): functional-group
  context (AK1), the acked transaction set id/control number (AK201/AK202),
  the ack code + error codes (AK501-506), segment-level error codes (IK304 per
  IK3), and the group's own disposition (AK901). **Design note:** AK9 is a
  TRAILER — it is read AFTER every AK2/AK5 unit — so `_AckHandler` holds all
  units in memory and only appends them to `out` at `flush()` (called once, at
  SE), by which point AK9 has been seen. This is the one handler that departs
  from "emit as the loop closes"; every other handler emits per-loop because
  its context is a header (read first), not a trailer.
- `999` moves from `KNOWN_TRANSACTION_SETS` (recognised-but-refused) to
  `SUPPORTED_TRANSACTION_SETS`; `997` (the pre-5010 functional ack 999
  superseded) stays refused-by-name and is now the "recognised but not decoded"
  example test. 10 tests.

**inc-5 — BUILT.** Control-number persistence (STD-FR-013, BR-6, AC-6) and
duplicate-ISA rejection (STD-FR-043, AC-5) — the two Cross-cutting FRs that
needed real state, which is why they'd been deferred through inc-1..4 (every
other module in this BRD is deliberately a pure function). Migration `0008`
adds two tenant-isolated (RLS) tables, keyed on (tenant, sender_id,
receiver_id) rather than a formal trading-partner registry — STD-FR-040
doesn't exist yet, and sender/receiver ARE the partner identity carried in
every ISA, so this is the narrowest correct key today, not a placeholder.
- **`x12_control_sequences`** (BR-6/AC-6). `app/domain/x12_control.py::
  reserve_control_numbers` atomically advances a per-partner ISA/GS/ST
  counter, row-locked (`with_for_update`) with a nested-transaction retry for
  the first-ever reservation race. Wired into `writebacks.py::enqueue()`:
  Core now generates these numbers itself and **overrides any caller-supplied
  isa_control/gs_control/st_control** — before this increment those three
  fields were 100% caller-supplied with no persistence anywhere (confirmed by
  grep before starting), meaning nothing stopped two proposals reusing the
  same ISA number. `render_837`/`render_for_writeback` stay pure functions
  unchanged; the sequence lives one layer up, in the caller, matching how
  `x12_out.py` was already documented ("control numbers supplied by the
  caller, which owns the per-partner monotonic sequence").
- **`x12_seen_interchanges`** (STD-FR-043/AC-5). `check_and_record_isa`
  speculatively inserts inside a SAVEPOINT; the UNIQUE constraint on (tenant,
  sender, receiver, isa_control_number) is the actual guard, so it's correct
  under concurrent ingestion of the same file, not just a check-then-act
  race. A new `x12.py::parse_isa_identity` peeks just the ISA header (no full
  decode) so the guard can run BEFORE any row is staged (BR-2: zero rows on a
  replay); wired into `runner.py::_attempt_file` via a `_peek_prefix` helper
  that reads the prefix then replays it, so `decode_stream` sees the file
  unchanged.
- **Scope, stated honestly:** wired into the file-upload path
  (`_attempt_file`), verified through the REAL upload API (create → init →
  PUT parts → complete → inline runner), not the domain function in
  isolation — two ingestions of byte-identical X12 content, second one fails
  with `rows_appended: 0` and the ISA number in the error. **Correction to
  the note this section originally carried:** it's not that the
  connector-poll path's decode call site merely lacks `tenant_id` — investigated
  further and `ObjectSourceIngestor.ingest()` (the object-store/SFTP/S3/GCS/
  Azure decode-and-stage path) and the `fetchers` registry (SFTP/HTTP →
  object-store) both have **zero call sites anywhere in the runtime** (`grep`
  confirms it). SFTP/object-store-polled ingestion doesn't execute at all yet
  on this branch — a pre-existing ingestion-service gap, not specific to X12,
  and too large to fold into this BRD's scope. Once that path is wired up,
  it needs the same duplicate-ISA guard `_attempt_file` has.
- 16 new tests (513 total, up from 497): counter monotonicity + per-partner/
  per-tenant isolation + durability-across-a-fresh-session (proving the
  counter lives in the database, not memory), duplicate-ISA accept/reject/
  cross-partner/cross-tenant, and the writeback-API-level override test.

**inc-6 — BUILT.** Outbound 276 (claim status request, the second half of
STD-FR-012 — 837 was inc-2a). `x12_out.py::render_276` mirrors `render_837`'s
simplification (one payer/provider/subscriber per interchange, not per-claim
looping); `render_for_writeback` now dispatches on `target.transaction_set`
between 837 and 276, each with its own required payload key and identity
fields, rather than assuming 837. TRN02 carries `claim_id` — the SAME field
837's claims use — so a partner's 277 response (which echoes the requester's
TRN) correlates back through the already-built `_ClaimStatusHandler` the same
way an 835 already correlates to its 837. Rides the identical BR-1/BR-6
machinery inc-2b/inc-5 built: propose-time render, checksum, four-eyes, and
Core-generated control numbers shared with 837 on the SAME per-partner
sequence (an 837 then a 276 to the same payer get consecutive numbers, not
independent ones). 276 has no decoder (it's outbound-only, matching the
decode side's existing refusal), so unlike 837 it can't be round-trip
validated — tests instead parse the rendered segments directly and
cross-check the same conformance rules a decoder would (SE01 count,
ST02==SE02, envelope control numbers). 17 new tests (530 total).

**Remaining (transport + narrower registry gaps, deferred).** Bind SFTP/
object-store-polled ingestion execution itself (see the inc-5 correction
above — this doesn't run at all yet, independent of X12) and the FHIR REST
connector (paginated `_since` + SMART-on-FHIR auth); 277CA (claim
acknowledgment — a distinct BHT/2200D grammar from the 277 claim-status
response already built, not yet done); a formal trading-partner registry
(STD-FR-040 — inc-5's (tenant, sender, receiver) key is a correct interim
substitute, not this); ISO 20022 `pacs.002/008` read and `pain.001` write
(only `camt.05x` read exists); 837→277CA→835 materialized onto the owning
case row (the three currently correlate only via a shared `claim_id` column,
joinable in a query but not materialized by any pipeline).
