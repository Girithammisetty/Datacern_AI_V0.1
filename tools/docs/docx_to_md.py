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
from xml.etree import ElementTree as ET

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


def convert(src: Path) -> str:
    with zipfile.ZipFile(src) as z:
        xml = z.read("word/document.xml")
    body = ET.fromstring(xml).find(f"{W}body")
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
