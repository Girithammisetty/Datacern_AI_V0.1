import { describe, it, expect, vi, afterEach } from "vitest";
import { escapeCsvField, toCsvRow, buildCsv, downloadCsv } from "./csv";

describe("escapeCsvField (RFC 4180 §2.5-2.7)", () => {
  it("leaves plain fields unquoted", () => {
    expect(escapeCsvField("case-triage")).toBe("case-triage");
    expect(escapeCsvField("")).toBe("");
  });

  it("quotes a field containing the delimiter", () => {
    expect(escapeCsvField("a,b")).toBe('"a,b"');
  });

  it("quotes a field containing a double quote and doubles it", () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes a field containing an embedded newline or CR", () => {
    expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCsvField("line1\rline2")).toBe('"line1\rline2"');
  });
});

describe("toCsvRow", () => {
  it("joins fields with commas, escaping each independently", () => {
    expect(toCsvRow(["a", "b,c", 'd"e'])).toBe('a,"b,c","d""e"');
  });
});

describe("buildCsv", () => {
  it("uses CRLF between every record, including after the last row", () => {
    const csv = buildCsv({ header: ["a", "b"], rows: [["1", "2"], ["3", "4"]] });
    expect(csv).toBe("a,b\r\n1,2\r\n3,4\r\n");
  });

  it("prefixes `#`-commented leading provenance lines before the header", () => {
    const csv = buildCsv({ leadingComments: ["generated 2026-07-26", "period X"], header: ["a"], rows: [["1"]] });
    expect(csv).toBe("# generated 2026-07-26\r\n# period X\r\na\r\n1\r\n");
  });

  it("round-trips a field containing comma, quote, and newline correctly quoted", () => {
    const csv = buildCsv({ header: ["col"], rows: [['has, "quote", and\nnewline']] });
    expect(csv).toBe('col\r\n"has, ""quote"", and\nnewline"\r\n');
  });

  it("produces an empty-but-valid document (header only) for zero rows", () => {
    expect(buildCsv({ header: ["a", "b"], rows: [] })).toBe("a,b\r\n");
  });
});

describe("downloadCsv", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a text/csv Blob with a UTF-8 BOM, downloads it via an anchor click, and revokes the URL", () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:mock-url");
    const revokeObjectURL = vi.fn();
    (URL as unknown as { createObjectURL: typeof createObjectURL }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: typeof revokeObjectURL }).revokeObjectURL = revokeObjectURL;

    const clickSpy = vi.fn();
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = realCreateElement(tag);
      if (tag === "a") el.click = clickSpy;
      return el;
    });

    downloadCsv("report.csv", "a,b\r\n1,2\r\n");

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/csv;charset=utf-8");
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });
});
