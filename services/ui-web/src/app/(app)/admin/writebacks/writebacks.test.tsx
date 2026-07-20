import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";

/**
 * BRD 57 BR-1: the approver must see the EXACT bytes that will transmit, not
 * a re-derived summary. `X12Preview` is what makes that true in both the
 * job-detail panel and the approve confirmation dialog (page.tsx wires it
 * into both). DataTable virtualizes rows via @tanstack/react-virtual, which
 * needs a real ResizeObserver-measured container it never gets in jsdom
 * (repo convention: DataTable.test.tsx / admin/tools/tools.test.tsx target
 * aria-rowcount + request variables, never row content) — so `X12Preview` is
 * tested directly here rather than through a simulated row click, which
 * tests the actual rendering logic more precisely than a flaky click-path
 * would anyway.
 */
let handler: (doc: string, vars: any) => any = () => ({});
vi.mock("@/lib/graphql/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/graphql/client")>();
  return {
    ...actual,
    graphqlRequest: (doc: string, vars: any) => Promise.resolve(handler(doc, vars)),
  };
});

import AdminWritebacksPage from "./page";
import { X12Preview, x12Segments } from "./X12Preview";

const RENDERED_837 =
  "ISA*00*          *00*          *ZZ*PROVIDER1      *ZZ*PAYERX         *210101*1200*^*00501*000000001*0*P*:~" +
  "GS*HC*PROVIDER1*PAYERX*20000101*0000*1*X*005010X222A1~ST*837*0001~" +
  "NM1*85*2*BILLING PROVIDER*****XX*1234567893~NM1*IL*1*SUBSCRIBER*****MI*MEMBER1~" +
  "CLM*CLAIM1*100.00**11:B:1~SE*4*0001~GE*1*1~IEA*1*000000001~";

describe("x12Segments", () => {
  it("splits a rendered interchange into trimmed, non-empty segments", () => {
    const segs = x12Segments({ x12_rendered: RENDERED_837 });
    expect(segs).not.toBeNull();
    expect(segs!.some((s) => s.startsWith("CLM*CLAIM1*100.00"))).toBe(true);
    expect(segs!.some((s) => s.startsWith("ST*837*0001"))).toBe(true);
    expect(segs!.every((s) => s.length > 0)).toBe(true);
  });

  it("returns null for a plain JSON payload with no x12_rendered field", () => {
    expect(x12Segments({ case_id: "42" })).toBeNull();
    expect(x12Segments(null)).toBeNull();
    expect(x12Segments("a string")).toBeNull();
    expect(x12Segments({ x12_rendered: "" })).toBeNull();
  });
});

describe("X12Preview", () => {
  it("renders every segment on its own line and the checksum prefix", () => {
    render(<X12Preview payload={{ x12_rendered: RENDERED_837, x12_checksum: "b".repeat(64) }} />);
    expect(screen.getByText(/Exact X12 interchange to be transmitted/)).toBeInTheDocument();
    expect(screen.getByText(/CLM\*CLAIM1\*100\.00/)).toBeInTheDocument();
    expect(screen.getByText(/sha256:bbbbbbbbbbbb/)).toBeInTheDocument();
  });

  it("renders nothing for a non-X12 payload", () => {
    const { container } = render(<X12Preview payload={{ case_id: "42" }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Admin write-backs page", () => {
  beforeEach(() => {
    handler = (doc: string) => {
      if (doc.includes("query Writebacks")) return { writebacks: [] };
      return {};
    };
  });

  it("renders (existing list wiring still works, unaffected by the X12Preview addition)", async () => {
    renderWithProviders(<AdminWritebacksPage />);
    await waitFor(() => {
      expect(screen.getByText("No write-backs yet.")).toBeInTheDocument();
    });
  });
});
