# Datacern documentation

Everything here is Markdown. There are no binary documents in this tree — see
[Format](#format) for why, and for how to convert one if you receive it.

## Layout

| Dir | Files | Contents |
|---|---:|---|
| [`brd/`](brd/) | 78 | Business requirements per service — **the source of truth for scope**. Start at [`00_MASTER_BRD.md`](brd/00_MASTER_BRD.md) |
| [`architecture/`](architecture/) | 2 | Technical and deployment architecture |
| [`platform/`](platform/) | 8 | Conventions, agent/user guides, capability catalog |
| [`platform/playbooks/`](platform/playbooks/) | 25 | Per-vertical agent playbooks, one per pack |
| [`initiatives/`](initiatives/) | 30 | **Full-lifecycle change docs — every substantive change lives here** |
| [`design/`](design/) | 9 | Earlier per-feature design notes (problem → phases → status) |
| [`demo/`](demo/) | 4 | Demo runbooks |
| [`security/`](security/) | 1 | [Security posture](security/SECURITY_POSTURE.md) — controls **and** explicit non-claims |

## Platform state, and where to check it

Counts drift, so they are verified rather than asserted.
`tools/docs/check_doc_facts.py` runs in CI and fails when a documented count
contradicts the repository:

| Fact | Value | Derived from |
|---|---:|---|
| Deployable services | 24 | `deploy/services.yaml` |
| Capability packs | 28 | `packs/*/pack.yaml` |
| BRDs | 78 | `docs/brd/*.md` |
| Packs with a seeded demo scenario | 4 | `deploy/demo/*/cases.yaml` |

For what is **not** built — no customers, no production deployment, no SOC 2 or
HITRUST, no third-party penetration test — see
[`DATACERN_PARTNER_BRIEFING.md`](DATACERN_PARTNER_BRIEFING.md) §3 and
[`security/SECURITY_POSTURE.md`](security/SECURITY_POSTURE.md). Those lists are
maintained deliberately; keep them accurate rather than flattering.

## Root documents

| Doc | Purpose |
|---|---|
| [`WHAT_DATACERN_IS.md`](WHAT_DATACERN_IS.md) | The plain-language explanation. Start here. |
| [`DATACERN_PARTNER_BRIEFING.md`](DATACERN_PARTNER_BRIEFING.md) | Verified capability + gap list for partner and investor conversations |
| [`DATACERN_LOCAL_EVALUATION_EVIDENCE_2026-07-30.md`](DATACERN_LOCAL_EVALUATION_EVIDENCE_2026-07-30.md) | Recorded evidence from a local evaluation run |
| [`DATACERN_MCP_CONNECTIVITY.md`](DATACERN_MCP_CONNECTIVITY.md) | What MCP does and does not do here, by direction |
| [`DATACERN_REALTIME_HEALTHCARE_POSITION.md`](DATACERN_REALTIME_HEALTHCARE_POSITION.md) | The "healthcare is real-time, you look batch" answer |
| [`DATACERN_COMPETITIVE_LANDSCAPE_AND_GTM_ROADMAP.md`](DATACERN_COMPETITIVE_LANDSCAPE_AND_GTM_ROADMAP.md) | Competitive read and go-to-market roadmap |
| [`DATACERN_POSITIONING_OPTIONS_SLM_AND_AGENTS.md`](DATACERN_POSITIONING_OPTIONS_SLM_AND_AGENTS.md) | Positioning options around small models and agents |
| [`DATACERN_GAINWELL_FIT.md`](DATACERN_GAINWELL_FIT.md) | Fit analysis against a Medicaid data estate |
| [`DATACERN_CEO_PITCH.md`](DATACERN_CEO_PITCH.md) | Partnership pitch. **Contains internal prep — the `.html` beside it is the shareable subset.** |
| [`DATACERN_2035_VISION.md`](DATACERN_2035_VISION.md) | Long-range direction — **bets, clearly separated from claims** |

## Documentation convention (standing)

Every substantive change is documented as one file under
[`initiatives/`](initiatives/), following this three-phase pattern (see
[`_TEMPLATE.md`](_TEMPLATE.md)):

1. **Analysis**
   - **Platform / product** — why it matters to the product and the customer; the problem, who it affects, the outcome.
   - **Technical** — the current state in code with `file:line` evidence; the root cause; what is already there vs missing. No guessing — cite the code.
2. **Architecture & Design** — the approach, the options weighed, the decision and why, the contracts and invariants, and what stays out of scope.
3. **Implementation & Test** — what was built (files + commits), how it was verified (tests + live evidence), and what is explicitly deferred.

Keep it honest: record what was verified versus assumed, and flag known gaps
rather than hide them. A document that overstates the platform is a defect in
the same way a failing test is.

The initiatives index is the directory itself. A hand-maintained list goes stale
the first time somebody forgets to update it — this one listed 3 of 27 files —
so [browse `initiatives/`](initiatives/) instead.

## Format

Markdown only, and deliberately.

`docs/` previously carried 32 `.docx` files totalling 26 MB, with no generator
anywhere in the repository. Git could not diff them, review could not read them,
and `grep` could not see inside them — which is how 31 of the 32 came to still
brand the platform "Windrose AI", a name it no longer uses, without anyone
noticing.

They were converted to Markdown and the binaries deleted. Converted files carry
a banner marking them as point-in-time snapshots, because several state figures
that were true when written and have not been re-verified since.

If you receive a Word document worth keeping:

```bash
python3 tools/docs/docx_to_md.py path/to/file.docx    # -> path/to/file.md
python3 tools/docs/docx_to_md.py --tree docs          # convert every .docx found
```

Text, headings and tables survive; embedded images and revision history do not.
Commit the Markdown, not the `.docx`.
