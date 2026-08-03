#!/usr/bin/env python3
"""Convert a .docx to Markdown with no third-party dependencies.

WHY THIS EXISTS. `docs/` carried 32 .docx files, 26 MB of them, with no
generator anywhere in the repo — orphaned binary artifacts that git cannot diff,
review or grep. 31 of the 32 still branded the platform "WINDROSE AI", a name it
no longer uses, and nobody could see that because the content was inside a zip.

A .docx IS a zip of XML, so the conversion needs no library: read
`word/document.xml`, walk paragraphs and tables, map Word's built-in Heading
styles to ATX levels, and emit Markdown. Runs of the same list style become list
items; `w:tbl` becomes a GitHub table.

Deliberately lossy in one direction only: text, structure and tables survive;
embedded images, fonts and revision history do not. That is the right trade for
documents whose value is their words — and it is why the originals are deleted
in the same commit rather than kept "just in case", which is how 26 MB of
unreviewable binaries accumulated in the first place.

Usage:
    python3 tools/docs/docx_to_md.py <in.docx> [out.md]
    python3 tools/docs/docx_to_md.py --tree docs      # convert every .docx found
"""
from __future__ import annotations

import re
import sys
import zipfile
from pathlib import Path
# use-defused-xml. Bare, with NOTHING after it — see the note in _reject_dtd for
# why every qualified form was tried first and none of them held. Entity
# expansion is defeated in _reject_dtd, not by these comments.
import xml.etree.ElementTree as ET  # nosemgrep
import xml.parsers.expat as expat  # nosemgrep

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

# Renames applied to every converted document. The platform was renamed and the
# .docx set never was; converting without fixing this would carry a dead brand
# forward into the format we intend people to actually read.
RENAMES = [
    (re.compile(r"\bWINDROSE\s+AI\b"), "DATACERN AI"),
    (re.compile(r"\bWindrose\s+AI\b"), "Datacern AI"),
    (re.compile(r"\bwindrose\s+ai\b"), "datacern ai"),
    (re.compile(r"\bWINDROSE\b"), "DATACERN"),
    (re.compile(r"\bWindrose\b"), "Datacern"),
    (re.compile(r"\bwindrose\b"), "datacern"),
]


def _rename(s: str) -> str:
    for pat, sub in RENAMES:
        s = pat.sub(sub, s)
    return s


def _text(el) -> str:
    """Concatenate the text runs under an element, honouring breaks and tabs."""
    out: list[str] = []
    for node in el.iter():
        if node.tag == f"{W}t":
            out.append(node.text or "")
        elif node.tag in (f"{W}tab",):
            out.append(" ")
        elif node.tag in (f"{W}br", f"{W}cr"):
            out.append(" ")
    return re.sub(r"[ \t]+", " ", "".join(out)).strip()


def _style(p) -> str:
    pr = p.find(f"{W}pPr")
    if pr is None:
        return ""
    st = pr.find(f"{W}pStyle")
    return (st.get(f"{W}val") or "") if st is not None else ""


def _heading_level(style: str) -> int | None:
    m = re.fullmatch(r"[Hh]eading\s?([1-6])", style)
    if m:
        return int(m.group(1))
    if style.lower() in ("title",):
        return 1
    if style.lower() in ("subtitle",):
        return 2
    return None


def _is_list(style: str) -> bool:
    return "list" in style.lower() and "paragraph" in style.lower()


def _numbered(p) -> bool:
    pr = p.find(f"{W}pPr")
    return pr is not None and pr.find(f"{W}numPr") is not None


def _cell_text(tc) -> str:
    parts = [_text(p) for p in tc.findall(f"{W}p")]
    return " ".join(x for x in parts if x).replace("|", "\\|")


def _table_md(tbl) -> list[str]:
    rows: list[list[str]] = []
    for tr in tbl.findall(f"{W}tr"):
        rows.append([_cell_text(tc) for tc in tr.findall(f"{W}tc")])
    rows = [r for r in rows if any(c.strip() for c in r)]
    if not rows:
        return []
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    head, body = rows[0], rows[1:]
    out = ["| " + " | ".join(head) + " |",
           "|" + "|".join(["---"] * width) + "|"]
    out += ["| " + " | ".join(r) + " |" for r in body]
    return out


class _DtdRejected(Exception):
    """A DOCTYPE was seen in the XML prolog (entity-expansion DoS vector)."""


class _PrologDone(Exception):
    """The root element started with no DOCTYPE — the prolog is clean."""


def _reject_dtd(xml: bytes) -> None:
    """Reject a document.xml that declares a DTD/DOCTYPE, defeating the internal
    entity-expansion ("billion laughs") DoS without adding a dependency.

    Same mitigation ingestion-service applies to uploaded XML
    (app/domain/decode.py::_reject_dtd), for the same reason: internal entities —
    the expansion vector — can only be declared inside a DOCTYPE, and a DOCTYPE is
    only legal in the prolog. One expat pass that bails at the first DOCTYPE
    (reject) or the first element start (clean) settles it without parsing any
    content, and stdlib expat never resolves EXTERNAL entities.

    A .docx is a zip an operator hands this tool, not a network input, so the
    realistic risk is low — but "the caller is trusted" is exactly the assumption
    that stops being true later, and the check costs one pass over the prolog.

    On the bare `# nosemgrep` at the imports. The rule is
    python.lang.security.use-defused-xml.use-defused-xml, and it fires on the
    MODULE IMPORT, not on the parse call — so a suppression on the ET.fromstring
    line below guards a line that is never reported. Three qualified forms were
    tried against real CI, in this order, and all three were still reported:

        # nosemgrep: use-defused-xml                            (short id)
        # nosemgrep: python.lang.security.use-defused-xml....   (full id)
        ... either of the above followed by  # noqa: E501

    Do not "improve" these back into a named form without checking CI. A local
    semgrep run cannot settle it: semgrep prefixes rule ids loaded from a local
    config with that file's path, so a named comment matches as a SUFFIX and
    every form appears to work offline. semgrep.dev is unreachable here, so the
    registry rule itself cannot be fetched to test against.

    xml_standards.py carries `# nosemgrep: use-defused-xml` and is green — not
    because the comment works, but because `import xml.etree.ElementTree` is a
    form the rule does not match. That comment is decorative; copying it is what
    started this.
    """
    p = expat.ParserCreate()

    def _on_doctype(*_a):
        raise _DtdRejected()

    def _on_start(*_a):
        raise _PrologDone()

    p.StartDoctypeDeclHandler = _on_doctype
    p.StartElementHandler = _on_start
    try:
        p.Parse(xml, True)
    except _DtdRejected:
        raise SystemExit("refusing to convert: document.xml declares a DTD") from None
    except _PrologDone:
        return  # reached the root element, prolog is clean
    except expat.ExpatError:
        return  # malformed — let ET produce the real, more useful error


def convert(src: Path) -> str:
    with zipfile.ZipFile(src) as z:
        xml = z.read("word/document.xml")
    _reject_dtd(xml)
    # use-defused-xml, mitigated by _reject_dtd directly above. The suppression is
    # left UNQUALIFIED on purpose: ingestion-service names
    # python.lang.security.use-defused-xml-parse.use-defused-xml-parse for its
    # ET.parse call, and it is not verifiable from here whether fromstring trips
    # that same id or a sibling — semgrep.dev is unreachable in this environment,
    # so a named id would be a guess that costs a full CI cycle when wrong.
    body = ET.fromstring(xml).find(f"{W}body")  # nosemgrep
    if body is None:
        return ""

    lines: list[str] = []
    prev_blank = True

    def emit(s: str = "") -> None:
        nonlocal prev_blank
        if s == "":
            if not prev_blank:
                lines.append("")
                prev_blank = True
            return
        lines.append(s)
        prev_blank = False

    for el in body:
        if el.tag == f"{W}tbl":
            emit()
            for row in _table_md(el):
                emit(row)
            emit()
            continue
        if el.tag != f"{W}p":
            continue

        txt = _text(el)
        if not txt:
            continue
        style = _style(el)

        lvl = _heading_level(style)
        if lvl:
            emit()
            emit("#" * min(lvl, 6) + " " + txt)
            emit()
        elif _is_list(style) or _numbered(el):
            emit("- " + txt)
        else:
            emit()
            emit(txt)
            emit()

    md = "\n".join(lines).strip() + "\n"
    md = re.sub(r"\n{3,}", "\n\n", md)
    md = _rename(md)

    # Provenance banner. These documents are DATED SNAPSHOTS — several state
    # counts ("22 services") that were true when they were written and are not
    # true now. Converting is not the moment to silently rewrite dozens of
    # capability claims nobody has re-verified line by line; saying plainly that
    # the file is a snapshot is both cheaper and more honest. Whoever needs a
    # given section current can update that section against the code and drop
    # its line from the banner.
    banner = (
        f"<!-- converted from {src.name} by tools/docs/docx_to_md.py -->\n"
        "> **Converted from Word.** This is a point-in-time snapshot: figures in it were "
        "accurate on the date stated below and have not been re-verified against the "
        "current codebase. For counts that are checked continuously, see the root "
        "[`README.md`](../../README.md).\n\n"
    )
    return banner + md


def out_path(src: Path) -> Path:
    return src.with_suffix(".md")


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    if argv[0] == "--tree":
        root = Path(argv[1] if len(argv) > 1 else "docs")
        found = sorted(root.rglob("*.docx"))
        if not found:
            print(f"no .docx under {root}")
            return 0
        for src in found:
            dst = out_path(src)
            try:
                md = convert(src)
            except Exception as e:  # noqa: BLE001 - report and continue the batch
                print(f"  FAIL {src}: {type(e).__name__}: {e}")
                continue
            dst.write_text(md, encoding="utf8")
            print(f"  ok   {src.name} -> {dst.name}  ({len(md.splitlines())} lines)")
        return 0

    src = Path(argv[0])
    dst = Path(argv[1]) if len(argv) > 1 else out_path(src)
    dst.write_text(convert(src), encoding="utf8")
    print(f"{src} -> {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
