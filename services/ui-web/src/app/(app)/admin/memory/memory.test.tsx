import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils";

// jsdom reports 0 offsetHeight, so the DataTable virtualizer would window to
// zero rows; give elements a size so the row-action tests can click table rows.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 1200 });
});

/** Same conventions as admin/usage/usage.test.tsx. */
let handler: (doc: string, vars: any) => any = () => ({});
const requests: { doc: string; vars: any }[] = [];
vi.mock("@/lib/graphql/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/graphql/client")>();
  return {
    ...actual,
    graphqlRequest: (doc: string, vars: any) => {
      requests.push({ doc, vars });
      return Promise.resolve(handler(doc, vars));
    },
  };
});

import AdminMemoryPage from "./page";

const meResult = {
  me: { userId: "u-1", tenantId: "t-42", type: "user", scopes: [], roles: ["Admin"], capabilities: ["*"], capsDegraded: false },
};

const emptyMemories = { memories: { nodes: [], pageInfo: { nextCursor: null, hasMore: false } } };
const emptyStats = { memoryStats: { total_records: 0 } };
const defaultPolicy = {
  memoryPolicy: { ttlOverrides: { user: "P30D" }, piiClasses: ["email"], injectionProfile: "standard", corpusFlags: { docs: true } },
};

/** Shared baseline responses so every render settles; tests layer extra docs on
 * top. NOTE: the Me match needs the "{" — a bare "query Me" is a prefix of every
 * "query Memor…" document and would shadow the memory queries. */
function baseHandler(doc: string): any {
  if (doc.includes("query Me {")) return meResult;
  if (doc.includes("query Memories")) return emptyMemories;
  if (doc.includes("query MemoryStats")) return emptyStats;
  if (doc.includes("query MemoryPolicy")) return defaultPolicy;
  return {};
}

beforeEach(() => {
  requests.length = 0;
  handler = baseHandler;
});

describe("Admin Memory page — right-to-be-forgotten erasure", () => {
  it("requires typing the subject id to confirm before requesting erasure", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminMemoryPage />);

    await user.type(await screen.findByLabelText("Subject id"), "u-42");
    await user.click(screen.getByRole("button", { name: "Request erasure" }));

    const dialog = await screen.findByRole("dialog");
    const confirmBtn = within(dialog).getByRole("button", { name: "Request erasure" });
    expect(confirmBtn).toBeDisabled();

    await user.type(within(dialog).getByRole("textbox"), "u-42");
    expect(confirmBtn).toBeEnabled();

    handler = (doc: string) => {
      if (doc.includes("mutation RequestMemoryErasure")) {
        return { requestMemoryErasure: { operationId: "op-1", status: "received", report: null, completedAt: null } };
      }
      if (doc.includes("query Erasure")) {
        return { erasure: { operationId: "op-1", status: "completed", report: { erased: 3 }, completedAt: "2026-07-12T00:00:00Z" } };
      }
      return baseHandler(doc);
    };
    await user.click(confirmBtn);

    await waitFor(() => {
      const call = requests.find((r) => r.doc.includes("mutation RequestMemoryErasure"));
      expect(call?.vars).toMatchObject({ subjectId: "u-42", subjectType: "user" });
    });
    await screen.findByText("op-1");
    await screen.findByText("completed");
  });
});

describe("Admin Memory page — browse", () => {
  it("filters memories by scope + scope ref", async () => {
    handler = (doc: string, vars: any) => {
      if (doc.includes("query Memories")) {
        if (vars.scope === "workspace" && vars.scopeRef === "ws-9") {
          return {
            memories: {
              nodes: [{ id: "m-1", urn: "wr:t:memory:record/m-1", scope: "workspace", scopeRef: "ws-9",
                content: "the claim total is $4,200", confidence: 0.9, status: "active", tags: [],
                retrievalCount: 2, classifierScore: 0.1, ttlExpiresAt: null }],
              pageInfo: { nextCursor: null, hasMore: false },
            },
          };
        }
        return emptyMemories;
      }
      return baseHandler(doc);
    };
    const user = userEvent.setup();
    renderWithProviders(<AdminMemoryPage />);

    await user.selectOptions(await screen.findByLabelText("Scope"), "workspace");
    await user.type(screen.getByLabelText("Scope ref (e.g. workspace id)"), "ws-9");

    await waitFor(() => {
      const matching = requests.filter((r) => r.doc.includes("query Memories"));
      const call = matching[matching.length - 1];
      expect(call?.vars).toMatchObject({ scope: "workspace", scopeRef: "ws-9" });
    });
  });
});

describe("Admin Memory page — retrieval tester", () => {
  it("runs a scoped retrieval and renders ranked hits with scores", async () => {
    handler = (doc: string) => {
      if (doc.includes("query MemoryRetrievalTest")) {
        return {
          memoryRetrievalTest: {
            degraded: false,
            hits: [
              { kind: "memory", content: "the claim total is $4,200", score: 0.9123,
                contentDisposition: "untrusted", scope: "user", memoryId: "m-1",
                corpus: null, chunkId: null, sourceUrn: null, snapshotVer: null },
              { kind: "chunk", content: "claims are settled monthly", score: 0.71,
                contentDisposition: "untrusted", scope: null, memoryId: null,
                corpus: "docs", chunkId: "c-1", sourceUrn: "urn:doc:handbook", snapshotVer: "2026-08-01" },
            ],
          },
        };
      }
      return baseHandler(doc);
    };
    const user = userEvent.setup();
    renderWithProviders(<AdminMemoryPage />);

    await user.type(await screen.findByLabelText("Query text"), "claim total");
    await user.click(screen.getByRole("button", { name: "Run retrieval" }));

    await waitFor(() => {
      const call = requests.find((r) => r.doc.includes("query MemoryRetrievalTest"));
      expect(call?.vars).toMatchObject({ input: { queryText: "claim total", scopes: ["user"], topK: 8 } });
    });
    await screen.findByText("0.9123");
    await screen.findByText("claims are settled monthly");
  });
});

describe("Admin Memory page — memory row actions", () => {
  const quarantined = {
    id: "m-2", urn: "wr:t:memory:record/m-2", scope: "user", scopeRef: "u-1",
    content: "suspicious content", confidence: 0.4, status: "quarantined", tags: [],
    retrievalCount: 0, classifierScore: 0.9, ttlExpiresAt: null,
  };

  it("shows unquarantine (reason required) only for quarantined records", async () => {
    handler = (doc: string) => {
      if (doc.includes("query Memories")) {
        return { memories: { nodes: [quarantined], pageInfo: { nextCursor: null, hasMore: false } } };
      }
      if (/query Memory\b/.test(doc)) {
        return { memory: { ...quarantined, provenance: null, mergedFrom: [], revalidateAt: null } };
      }
      if (doc.includes("mutation UnquarantineMemory")) {
        return { unquarantineMemory: { ...quarantined, status: "active", provenance: null, mergedFrom: [], revalidateAt: null } };
      }
      return baseHandler(doc);
    };
    const user = userEvent.setup();
    renderWithProviders(<AdminMemoryPage />);

    await user.click(await screen.findByText("suspicious content"));

    const reasonInput = await screen.findByLabelText("Unquarantine reason");
    const btn = screen.getByRole("button", { name: "Unquarantine" });
    expect(btn).toBeDisabled();
    await user.type(reasonInput, "false positive");
    expect(btn).toBeEnabled();
    await user.click(btn);

    await waitFor(() => {
      const call = requests.find((r) => r.doc.includes("mutation UnquarantineMemory"));
      expect(call?.vars).toMatchObject({ id: "m-2", reason: "false positive" });
    });
  });

  it("deletes a record after confirmation", async () => {
    const active = { ...quarantined, id: "m-3", status: "active", content: "old fact" };
    handler = (doc: string) => {
      if (doc.includes("query Memories")) {
        return { memories: { nodes: [active], pageInfo: { nextCursor: null, hasMore: false } } };
      }
      if (/query Memory\b/.test(doc)) {
        return { memory: { ...active, provenance: null, mergedFrom: [], revalidateAt: null } };
      }
      if (doc.includes("mutation DeleteMemory")) return { deleteMemory: true };
      return baseHandler(doc);
    };
    const user = userEvent.setup();
    renderWithProviders(<AdminMemoryPage />);

    await user.click(await screen.findByText("old fact"));
    await user.click(await screen.findByRole("button", { name: "Delete record" }));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete record" }));

    await waitFor(() => {
      const call = requests.find((r) => r.doc.includes("mutation DeleteMemory"));
      expect(call?.vars).toMatchObject({ id: "m-3" });
    });
  });
});

describe("Admin Memory page — tenant policy editor", () => {
  it("loads the policy and PUTs the edited document", async () => {
    handler = (doc: string) => {
      if (doc.includes("mutation SetMemoryPolicy")) {
        return {
          setMemoryPolicy: { ttlOverrides: { user: "P30D" }, piiClasses: ["email", "phone"],
            injectionProfile: "strict", corpusFlags: { docs: true } },
        };
      }
      return baseHandler(doc);
    };
    const user = userEvent.setup();
    renderWithProviders(<AdminMemoryPage />);

    // read view shows the downstream policy
    await screen.findByText("standard");
    await user.click(screen.getByRole("button", { name: "Edit policy" }));

    await user.selectOptions(await screen.findByLabelText("Injection profile"), "strict");
    const pii = screen.getByLabelText("PII classes");
    await user.clear(pii);
    await user.type(pii, "email, phone");
    await user.click(screen.getByRole("button", { name: "Save policy" }));

    await waitFor(() => {
      const call = requests.find((r) => r.doc.includes("mutation SetMemoryPolicy"));
      expect(call?.vars).toMatchObject({
        input: { injectionProfile: "strict", piiClasses: ["email", "phone"], ttlOverrides: { user: "P30D" }, corpusFlags: { docs: true } },
      });
    });
  });
});

describe("Admin Memory page — corpora", () => {
  it("loads corpus status and requests a rebuild with a new embedding version", async () => {
    handler = (doc: string) => {
      if (doc.includes("query CorpusStatus")) {
        return { corpusStatus: { corpusKey: "docs", status: "active", activeEmbeddingVer: "v2", chunkCount: 128 } };
      }
      if (doc.includes("mutation RebuildCorpus")) {
        return { rebuildCorpus: { corpusKey: "docs", activeEmbeddingVer: "v3", chunksReembedded: 128, oldChunksDropped: 128 } };
      }
      return baseHandler(doc);
    };
    const user = userEvent.setup();
    renderWithProviders(<AdminMemoryPage />);

    await user.click(await screen.findByRole("button", { name: "Load status" }));
    await screen.findByText("128 chunk(s)");

    await user.type(screen.getByLabelText("New embedding version"), "v3");
    await user.click(screen.getByRole("button", { name: "Rebuild" }));

    await waitFor(() => {
      const call = requests.find((r) => r.doc.includes("mutation RebuildCorpus"));
      expect(call?.vars).toMatchObject({ corpusKey: "docs", embeddingModelVer: "v3" });
    });
    await screen.findByText(/Re-embedded 128 chunk/);
  });
});
