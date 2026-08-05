#!/usr/bin/env python3
"""Cross-layer UI wiring audit: page -> hooks -> operations -> BFF schema ->
resolvers -> downstream service routes.

Nothing here executes the stack. This is the static half of "do the UI's
workflows actually reach something real": every GraphQL operation the UI can
send is checked against the schema the BFF declares, every declared field is
checked for a resolver implementation, every page is checked for reachable data
wiring, and every path the BFF's downstream clients hit is checked against the
routes the services actually register. The dynamic half is the e2e suites; this
tool exists because tsc validates none of the above (GraphQL documents are
opaque strings to it).

Usage:  python3 tools/wiring/audit_ui_wiring.py [--json out.json] [--md out.md]
Exit 1 when a BLOCKING finding exists (A/B below), 0 otherwise.

Findings:
  A  ui-operation-field-missing-in-schema   BLOCKING  (runtime GraphQL error)
  B  schema-field-without-resolver          BLOCKING  (silent null at runtime)
  C  schema-field-unused-by-ui              info      (dead API surface)
  D  resolver-without-schema-field          info      (dead resolver code)
  E  page-without-data-wiring               info      (static page — verify intent)
  F  bff-client-path-without-downstream     review    (candidate 404; noisy layer)
  G  hook-unused-by-any-page                info      (dead client code)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
UI = ROOT / "services/ui-web/src"
BFF = ROOT / "services/bff-graphql/src"

# ---------------------------------------------------------------- utilities


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8", errors="replace")


def strip_block_docstrings(s: str) -> str:
    """Remove GraphQL SDL triple-quoted descriptions (they may contain braces)."""
    return re.sub(r'"""[\s\S]*?"""', "", s)


def strip_comments_ts(s: str) -> str:
    s = re.sub(r"/\*[\s\S]*?\*/", "", s)
    return re.sub(r"(?m)^\s*//.*$", "", s)


def blank_noncode(s: str) -> str:
    """One pass that blanks comment bodies AND string-literal bodies together.

    They cannot be handled by sequential regexes: a block-comment regex matches
    the `/*` inside a glob string like "**/*.ts" and eats real code up to the
    next `*/`, and an apostrophe inside a comment ("don't") derails a
    string-blanking pass. Tokenizing both at once is the only ordering that
    works. Newlines are preserved so nothing else shifts lines; brackets inside
    strings/comments vanish, which is the whole point for depth tracking."""
    out = []
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        nxt = s[i + 1] if i + 1 < n else ""
        if c == "/" and nxt == "/":
            while i < n and s[i] != "\n":
                i += 1
        elif c == "/" and nxt == "*":
            i += 2
            while i + 1 < n and not (s[i] == "*" and s[i + 1] == "/"):
                if s[i] == "\n":
                    out.append("\n")
                i += 1
            i += 2
        elif c in ("'", '"', "`"):
            out.append(c)
            i += 1
            while i < n:
                if s[i] == "\\":
                    i += 2
                    continue
                if s[i] == "\n":
                    out.append("\n")
                if s[i] == c:
                    out.append(c)
                    i += 1
                    break
                i += 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


def extract_string_literals(s: str) -> list[str]:
    """All string/template literal bodies, skipping comments — one pass, same
    tokenizer discipline as blank_noncode (see its docstring for why regexes
    cannot do this)."""
    out: list[str] = []
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        nxt = s[i + 1] if i + 1 < n else ""
        if c == "/" and nxt == "/":
            while i < n and s[i] != "\n":
                i += 1
        elif c == "/" and nxt == "*":
            i += 2
            while i + 1 < n and not (s[i] == "*" and s[i + 1] == "/"):
                i += 1
            i += 2
        elif c in ("'", '"', "`"):
            j = i + 1
            buf = []
            while j < n:
                if s[j] == "\\":
                    buf.append(s[j : j + 2])
                    j += 2
                    continue
                if s[j] == c:
                    break
                buf.append(s[j])
                j += 1
            out.append("".join(buf))
            i = j + 1
        else:
            i += 1
    return out


def block_after(s: str, start: int) -> str:
    """Return the balanced {...} block whose opening brace is at/after `start`."""
    i = s.index("{", start)
    depth = 0
    for j in range(i, len(s)):
        if s[j] == "{":
            depth += 1
        elif s[j] == "}":
            depth -= 1
            if depth == 0:
                return s[i + 1 : j]
    return s[i + 1 :]


def top_level_fields(selection: str) -> list[str]:
    """Field names at depth 1 of a GraphQL selection set (alias-aware)."""
    out, depth, i = [], 0, 0
    token = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
    while i < len(selection):
        c = selection[i]
        if c == "{":
            depth += 1
            i += 1
        elif c == "}":
            depth -= 1
            i += 1
        elif c == "(":  # skip argument lists entirely
            d = 1
            i += 1
            while i < len(selection) and d:
                d += selection[i] == "("
                d -= selection[i] == ")"
                i += 1
        elif depth == 0 and (m := token.match(selection, i)):
            name = m.group(0)
            i = m.end()
            # alias: `alias: realField` — the schema field is the right-hand one
            rest = selection[i:]
            if (am := re.match(r"\s*:\s*([A-Za-z_][A-Za-z0-9_]*)", rest)):
                name = am.group(1)
                i += am.end()
            if name not in ("__typename",):
                out.append(name)
        else:
            i += 1
    return out


# ------------------------------------------------- layer 1: UI operations


def parse_operations() -> dict[str, dict]:
    """All GraphQL documents the UI can send. Primary source is operations.ts;
    inline /* GraphQL */ templates anywhere else under src/ (e.g. Next server
    routes) are collected too, tagged with their file."""
    ops: dict[str, dict] = {}
    doc_re = re.compile(
        r"`\s*\n?\s*(query|mutation)\s+([A-Za-z0-9_]+)\s*(?:\([^)]*\))?\s*\{",
    )
    for f in UI.rglob("*.ts*"):
        if "node_modules" in f.parts or f.suffix not in (".ts", ".tsx"):
            continue
        if any(part in ("tests-live", "tests-e2e", "__tests__") for part in f.parts):
            continue
        if f.name.endswith((".test.ts", ".test.tsx", ".spec.ts")):
            continue
        s = read(f)
        for m in doc_re.finditer(s):
            kind, name = m.group(1), m.group(2)
            body = block_after(s, m.end() - 1)
            key = f"{name}@{f.relative_to(ROOT)}"
            ops[key] = {
                "kind": kind,
                "name": name,
                "file": str(f.relative_to(ROOT)),
                "fields": top_level_fields(body),
            }
    return ops


# ------------------------------------------- layer 2: BFF schema + resolvers


def parse_schema() -> dict[str, set[str]]:
    s = strip_block_docstrings(read(BFF / "schema/typeDefs.ts"))
    out: dict[str, set[str]] = {}
    for typ in ("Query", "Mutation"):
        m = re.search(rf"\btype\s+{typ}\s*\{{", s)
        if not m:
            out[typ.lower()] = set()
            continue
        body = block_after(s, m.end() - 1)
        # Erase argument groups BEFORE matching field names: an arg list that
        # spans lines puts each `argName: Type` at line start, exactly where the
        # field regex looks — without this, every multiline field contributes
        # its arguments as phantom "fields" (observed: 39 of them). SDL parens
        # are balanced and contain no parens-in-strings after docstring strip.
        cleaned, depth = [], 0
        for ch in body:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            elif depth == 0:
                cleaned.append(ch)
            elif ch == "\n":
                cleaned.append("\n")  # keep line structure while inside args
        body = "".join(cleaned)
        # A field is `name:` (args now erased, so the colon follows directly).
        fields = set(re.findall(r"(?m)^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:", body))
        out[typ.lower()] = fields
    return out


def parse_resolvers() -> dict[str, set[str]]:
    """Indentation-based scan of the prettier-formatted resolver map.

    Brace/paren depth tracking is a dead end here without a real JS parser:
    regex literals like /[()]/ carry unbalanced brackets that no string-aware
    lexer fixes (observed: depth drifting to -6 mid-file and keys vanishing).
    The file is prettier-formatted, so structure IS indentation: `  Query: {`
    opens at indent 2, its keys sit at exactly indent 4, and the block closes
    at the next `  }` at indent 2. A formatter change breaks this loudly (the
    resolver count collapses and B explodes), not silently.
    """
    lines = blank_noncode(read(BFF / "resolvers/index.ts")).split("\n")
    out: dict[str, set[str]] = {"query": set(), "mutation": set()}
    spreads: dict[str, list[str]] = {"query": [], "mutation": []}
    current: str | None = None
    key_re = re.compile(r"^    (?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[:(]")
    spread_re = re.compile(r"^    \.\.\.([A-Za-z0-9_]+)")
    for ln in lines:
        if re.match(r"^  (Query)\s*:\s*\{", ln):
            current = "query"
            continue
        if re.match(r"^  (Mutation)\s*:\s*\{", ln):
            current = "mutation"
            continue
        if current and re.match(r"^  \}", ln):
            current = None
            continue
        if current:
            if (m := key_re.match(ln)):
                out[current].add(m.group(1))
            elif (m := spread_re.match(ln)):
                spreads[current].append(m.group(1))
    # spreads pull in resolver maps from sibling files (e.g. draftFields):
    # their keys sit at indent 2 inside `export const <name> = {`.
    for typ, names in spreads.items():
        for spread in names:
            for rf_ in (BFF / "resolvers").glob("*.ts"):
                rs = blank_noncode(read(rf_))
                dm = re.search(rf"\bconst\s+{spread}\s*(?::[^=]+)?=\s*\{{", rs)
                if dm:
                    for ln in rs[dm.end():].split("\n"):
                        if re.match(r"^\}", ln):
                            break
                        if (m := re.match(r"^  (?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[:(]", ln)):
                            out[typ].add(m.group(1))
    return out


# ------------------------------------------------- layer 3: page wiring


def build_import_graph() -> tuple[dict[Path, set[Path]], dict[Path, str]]:
    files = [
        f for f in UI.rglob("*.ts*")
        if "node_modules" not in f.parts and f.suffix in (".ts", ".tsx")
        and not f.name.endswith((".test.ts", ".test.tsx"))
        and not any(p in ("tests-live", "tests-e2e") for p in f.parts)
    ]
    contents = {f: read(f) for f in files}
    index: dict[str, Path] = {}
    for f in files:
        rel = f.relative_to(UI).with_suffix("")
        index[str(rel)] = f
    graph: dict[Path, set[Path]] = defaultdict(set)
    imp_re = re.compile(r"""(?:import|export)\s[^;]*?from\s+["']([^"']+)["']""")
    for f, s in contents.items():
        for spec in imp_re.findall(s):
            if spec.startswith("@/"):
                cand = spec[2:]
            elif spec.startswith("."):
                cand = str((f.parent / spec).resolve().relative_to(UI))
            else:
                continue
            for suffix in ("", "/index"):
                if (t := index.get(cand + suffix)) is not None:
                    graph[f].add(t)
                    break
    return graph, {f: s for f, s in contents.items()}


def page_wiring(graph, contents, hook_names: set[str], op_consts: set[str]):
    pages = sorted(UI.glob("app/**/page.tsx"))
    fetch_re = re.compile(r"""fetch\(\s*[`"'](/api/[^`"'?\s]*)""")
    ident_re = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
    # Precompute per-file facts ONCE (a per-page × per-file × per-name regex
    # sweep is quadratic and took minutes); reachability then just unions sets.
    facts: dict[Path, tuple[set[str], set[str], set[str]]] = {}
    for f, s in contents.items():
        idents = set(ident_re.findall(s))
        facts[f] = (idents & hook_names, idents & op_consts, set(fetch_re.findall(s)))
    results = {}
    for page in pages:
        seen, stack = set(), [page]
        hooks, consts, fetches = set(), set(), set()
        while stack:
            f = stack.pop()
            if f in seen:
                continue
            seen.add(f)
            fh, fc, ff = facts.get(f, (set(), set(), set()))
            hooks |= fh
            consts |= fc
            fetches |= ff
            stack.extend(graph.get(f, ()))
        route = "/" + str(page.parent.relative_to(UI / "app"))
        route = re.sub(r"/\((?:[^)]+)\)", "", route) or "/"
        results[route] = {
            "file": str(page.relative_to(ROOT)),
            "hooks": sorted(hooks),
            "op_consts": sorted(consts),
            "rest_fetches": sorted(fetches),
        }
    return results


# ------------------------------- layer 4: BFF clients vs downstream routes

CLIENT_SERVICE = {
    "agent": "agent-runtime", "aigateway": "ai-gateway", "audit": "audit-service",
    "case": "case-service", "chart": "chart-service", "dataset": "dataset-service",
    "eval": "eval-service", "experiment": "experiment-service",
    "identity": "identity-service", "inference": "inference-service",
    "ingestion": "ingestion-service", "memory": "memory-service",
    "notification": "notification-service", "pack": "pack-service",
    "pipelines": "pipeline-orchestrator", "query": "query-service",
    "rbac": "rbac-service", "semantic": "semantic-service",
    "toolplane": "tool-plane", "usage": "usage-service", "value": "usage-service",
}


def normalize(path: str) -> str:
    path = re.sub(r"\$\{[^}]*\}", "{}", path)      # ts template params
    path = re.sub(r"\{[^}]*\}", "{}", path)          # fastapi/chi params
    path = re.sub(r":([A-Za-z0-9_]+)", "{}", path)   # :param style
    return path.rstrip("/")


def client_paths() -> dict[str, set[str]]:
    out: dict[str, set[str]] = defaultdict(set)
    # Literals are extracted with the comment-aware tokenizer, not a bare
    # regex: an apostrophe in a doc comment ("the caller's token") opens a
    # phantom '...' region for a regex and misaligns every literal after it —
    # observed as a template literal truncated mid-interpolation.
    for f in (BFF / "clients").glob("*.ts"):
        svc = CLIENT_SERVICE.get(f.stem)
        if not svc:
            continue
        for raw in extract_string_literals(read(f)):
            if raw.startswith("/api/v"):
                # Normalize BEFORE splitting on "?": an interpolation may hold a
                # ternary (`${read ? "read" : "unread"}`), and splitting first
                # treats its "?" as a query string and truncates mid-template.
                out[svc].add(normalize(raw).split("?")[0].rstrip("/"))
    return out


def service_routes(svc: str) -> set[str]:
    base = ROOT / "services" / svc
    routes: set[str] = set()
    # FastAPI: each routes file declares its own APIRouter(prefix="...") — the
    # real path is prefix + decorated path. Ignoring the prefix produced 12
    # phantom misses (e.g. agent-runtime's /api/v1/registry/*). No prefix →
    # the repo-wide /api/v1 mount convention.
    for f in base.rglob("*.py"):
        if ".venv" in f.parts or "test" in f.name:
            continue
        s = read(f)
        pm = re.search(r"APIRouter\(\s*prefix\s*=\s*[\"']([^\"']+)", s)
        prefix = pm.group(1) if pm else ""
        for m in re.finditer(r"@router\.(?:get|post|patch|put|delete)\(\s*[\"']([^\"']*)", s):
            p = prefix + m.group(1) if prefix else m.group(1)
            routes.add(normalize(p if p.startswith("/api") else "/api/v1" + p))
    # Go chi: Route("/x", func(r) { ... }) nests, and the files are gofmt'd, so
    # TAB DEPTH is the nesting structure (the same trick as the resolver map —
    # brace tracking dies on regex literals, indentation does not). A Route line
    # at indent n sets the prefix for deeper lines until another line at ≤n.
    for f in base.rglob("*.go"):
        if "_test" in f.name:
            continue
        stack: list[tuple[int, str]] = []  # (indent, path segment)
        for ln in read(f).split("\n"):
            indent = len(ln) - len(ln.lstrip("\t"))
            if (m := re.search(r"\.(?:Route|Mount)\(\s*\"([^\"]+)\"", ln)):
                stack = [(i, p) for i, p in stack if i < indent]
                stack.append((indent, m.group(1)))
                if ".Mount(" in ln:  # mounted subrouter: register the prefix
                    routes.add(normalize("".join(p for _, p in stack)))
                continue
            verb_re = r"\.(?:Get|Post|Patch|Put|Delete|Handle(?:Func)?)\(\s*\"([^\"]+)\""
            if (m := re.search(verb_re, ln)):
                stack = [(i, p) for i, p in stack if i < indent]
                full = "".join(p for _, p in stack) + m.group(1)
                routes.add(normalize(full if full.startswith("/api") else "/api/v1" + full))
    return routes


def segments_compatible(client: str, route: str) -> bool:
    """Same segment count, and each pair matches literally or through a {}
    wildcard ON EITHER SIDE. A client-side interpolation may select among
    literal routes (`/byo/${id}/${action}` hits /byo/{id}/approve|reject), and a
    route-side param accepts any client literal — both directions are needed."""
    cs = [x for x in client.split("/") if x]
    rs = [x for x in route.split("/") if x]
    if len(cs) != len(rs):
        return False
    return all(a == b or a == "{}" or b == "{}" for a, b in zip(cs, rs, strict=True))


def match_downstream(cpaths: dict[str, set[str]]):
    """A client path matches when some registered route equals it, or is a
    suffix-mounted version of it (Go services often register subrouters)."""
    findings = []
    for svc, paths in sorted(cpaths.items()):
        routes = service_routes(svc)
        for p in sorted(paths):
            if p in routes:
                continue
            if any(segments_compatible(p, r) for r in routes):
                continue
            findings.append({"service": svc, "path": p})
    return findings


# --------------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", type=Path)
    ap.add_argument("--md", type=Path)
    args = ap.parse_args()

    ops = parse_operations()
    schema = parse_schema()
    resolvers = parse_resolvers()

    hooks_src = read(UI / "lib/graphql/hooks.ts")
    hook_names = set(re.findall(r"export function (use[A-Za-z0-9_]+)", hooks_src))
    op_consts = set(
        re.findall(r"export const ([A-Z0-9_]+)\s*=", read(UI / "lib/graphql/operations.ts"))
    )

    graph, contents = build_import_graph()
    pages = page_wiring(graph, contents, hook_names, op_consts)

    declared = schema["query"] | schema["mutation"]
    implemented = resolvers["query"] | resolvers["mutation"]

    A = [
        {"op": o["name"], "file": o["file"], "field": fld}
        for o in ops.values()
        for fld in o["fields"]
        if fld not in declared and not fld.startswith("__")
    ]
    B = sorted(
        (
            {"type": t, "field": f}
            for t in ("query", "mutation")
            for f in schema[t] - resolvers[t]
        ),
        key=lambda d: (d["type"], d["field"]),
    )
    used_fields = {fld for o in ops.values() for fld in o["fields"]}
    C = sorted(declared - used_fields)
    D = sorted(implemented - declared)
    E = sorted(
        r for r, w in pages.items()
        if not (w["hooks"] or w["op_consts"] or w["rest_fetches"])
    )
    F = match_downstream(client_paths())
    used_hooks = {h for w in pages.values() for h in w["hooks"]}
    G = sorted(hook_names - used_hooks)

    report = {
        "totals": {
            "pages": len(pages),
            "ui_operations": len(ops),
            "schema_fields": len(declared),
            "resolver_fields": len(implemented),
        },
        "A_ui_field_missing_in_schema": A,
        "B_schema_field_without_resolver": B,
        "C_schema_field_unused_by_ui": C,
        "D_resolver_without_schema_field": D,
        "E_pages_without_data_wiring": E,
        "F_client_path_without_downstream": F,
        "G_hooks_unused_by_pages": G,
        "pages": pages,
    }
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(report, indent=2))
    print(
        f"pages={len(pages)} ops={len(ops)} "
        f"schema_fields={len(declared)} resolvers={len(implemented)}"
    )
    for k in ("A_ui_field_missing_in_schema", "B_schema_field_without_resolver",
              "C_schema_field_unused_by_ui", "D_resolver_without_schema_field",
              "E_pages_without_data_wiring", "F_client_path_without_downstream",
              "G_hooks_unused_by_pages"):
        v = report[k]
        print(f"{k}: {len(v)}")
    blocking = bool(A or B)
    if blocking:
        print("\nBLOCKING findings (A/B):")
        for x in A[:40]:
            print(f"  A {x['field']}  <- {x['op']} ({x['file']})")
        for x in B[:40]:
            print(f"  B {x['type']}.{x['field']} has no resolver")
    return 1 if blocking else 0


if __name__ == "__main__":
    sys.exit(main())
