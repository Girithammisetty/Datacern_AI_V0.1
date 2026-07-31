import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils";

let latest: any = null;
/** The workspace's custom intake fields, as case-service's form model returns
 * them. Mutable so a test can run with or without a configured catalog. */
let customFields: any[] = [];
vi.mock("@/lib/graphql/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/graphql/client")>();
  return {
    ...actual,
    graphqlRequest: (doc: string, vars: any) => {
      if (doc.includes("mutation CreateCases")) {
        latest = vars;
        return Promise.resolve({
          createCases: {
            created: [{ id: "c-1", caseNumber: 1, status: "unassigned" }],
            deduplicated: [{ id: "c-0", rowPk: "CLM-2", caseNumber: 2 }],
          },
        });
      }
      if (doc.includes("query CaseForm")) {
        return Promise.resolve({
          caseForm: { mode: "create", defaults: [], customFields },
        });
      }
      if (doc.includes("AssignableUsers")) {
        return Promise.resolve({
          assignableUsers: {
            nodes: [
              { id: "u-ann", urn: "wr:t:user:user/u-ann", email: "ann@acme.co", fullName: "Ann Analyst" },
              { id: "u-bob", urn: "wr:t:user:user/u-bob", email: "bob@acme.co", fullName: "Bob Analyst" },
            ],
            pageInfo: { nextCursor: null, hasMore: false },
          },
        });
      }
      return Promise.resolve({});
    },
  };
});

import { CreateCasesDialog } from "./CreateCasesDialog";

const ROWS = [
  {
    rowPk: "CLM-1",
    displayProjection: [
      { key: "claim_id", value: "CLM-1" },
      { key: "status", value: "denied" },
    ],
  },
  {
    rowPk: "CLM-2",
    displayProjection: [
      { key: "claim_id", value: "CLM-2" },
      { key: "status", value: "denied" },
    ],
  },
];

beforeEach(() => {
  latest = null;
  customFields = [];
});

describe("CreateCasesDialog", () => {
  it("submits the selected rows as a worklist with severity + a future due date", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateCasesDialog
        open
        onOpenChange={() => {}}
        datasetUrn="wr:t:dataset:dataset/ds-1"
        queryUrn="wr:t:query:saved/q-1"
        rows={ROWS}
      />,
    );
    // header reflects the row → case mapping
    expect(screen.getByText(/2 rows → 2 cases/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Severity"), "high");
    await user.click(screen.getByRole("button", { name: /Create 2 cases/ }));

    await waitFor(() => expect(latest).not.toBeNull());
    expect(latest.input).toMatchObject({
      datasetUrn: "wr:t:dataset:dataset/ds-1",
      queryUrn: "wr:t:query:saved/q-1",
      severity: "high",
    });
    expect(latest.input.rows).toHaveLength(2);
    expect(latest.input.rows[0]).toMatchObject({ rowPk: "CLM-1" });
    // due date is sent and lies in the future
    expect(new Date(latest.input.dueDate).getTime()).toBeGreaterThan(Date.now());
  });

  it("shows the created + deduplicated summary after submit", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateCasesDialog
        open
        onOpenChange={() => {}}
        datasetUrn="wr:t:dataset:dataset/ds-1"
        rows={ROWS}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Create 2 cases/ }));
    await waitFor(() =>
      expect(
        screen.getAllByText((_, el) =>
          (el?.textContent ?? "").includes("1 case created") &&
          (el?.textContent ?? "").includes("already tracked (recurrence)"),
        ).length,
      ).toBeGreaterThan(0),
    );
  });

  it("routes the whole batch to one analyst picked by name", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateCasesDialog
        open
        onOpenChange={() => {}}
        datasetUrn="wr:t:dataset:dataset/ds-1"
        rows={ROWS}
      />,
    );
    // The assignee is a name picker (member-safe assignable users), not a raw id.
    await waitFor(() => expect(screen.getByRole("option", { name: "Bob Analyst" })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Assign all to"), "u-bob");
    await user.click(screen.getByRole("button", { name: /Create 2 cases/ }));

    await waitFor(() => expect(latest).not.toBeNull());
    expect(latest.input.assignedToId).toBe("u-bob");
  });

  it("blocks submit with no due date", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateCasesDialog
        open
        onOpenChange={() => {}}
        datasetUrn="wr:t:dataset:dataset/ds-1"
        rows={ROWS}
      />,
    );
    await user.clear(screen.getByLabelText("Due date"));
    await user.click(screen.getByRole("button", { name: /Create 2 cases/ }));
    await waitFor(() =>
      expect(screen.getByText("A due date is required.")).toBeInTheDocument(),
    );
    expect(latest).toBeNull();
  });

  // ---- slice 2: the workspace's own intake fields on the create form -------

  it("renders the workspace's custom fields and submits their values", async () => {
    customFields = [
      { name: "siu_referral", dataType: "enum", required: true, readonly: false,
        custom: true, queryScoped: false,
        fieldMeta: { label: "SIU referral", options: ["yes", "no"] } },
      { name: "exposure", dataType: "integer", required: false, readonly: false,
        custom: true, queryScoped: false, fieldMeta: { label: "Exposure" } },
    ];
    const user = userEvent.setup();
    renderWithProviders(
      <CreateCasesDialog open onOpenChange={() => {}}
        datasetUrn="wr:t:dataset:dataset/ds-1" rows={ROWS} />,
    );

    // The tenant configured these in settings; no code change put them here.
    const siu = await screen.findByLabelText(/SIU referral/);
    await user.selectOptions(siu, "yes");
    await user.type(screen.getByLabelText(/Exposure/), "4200");
    await user.click(screen.getByRole("button", { name: /Create 2 cases/ }));

    await waitFor(() => expect(latest).not.toBeNull());
    // Numeric fields arrive as NUMBERS — a typed catalog must not rot to strings.
    expect(latest.input.customFields).toEqual({ siu_referral: "yes", exposure: 4200 });
    expect(typeof latest.input.customFields.exposure).toBe("number");
  });

  it("blocks submit until a required custom field is filled", async () => {
    customFields = [
      { name: "siu_referral", dataType: "enum", required: true, readonly: false,
        custom: true, queryScoped: false,
        fieldMeta: { label: "SIU referral", options: ["yes", "no"] } },
    ];
    const user = userEvent.setup();
    renderWithProviders(
      <CreateCasesDialog open onOpenChange={() => {}}
        datasetUrn="wr:t:dataset:dataset/ds-1" rows={ROWS} />,
    );
    await screen.findByLabelText(/SIU referral/);
    await user.click(screen.getByRole("button", { name: /Create 2 cases/ }));

    expect(await screen.findByText(/SIU referral is required/)).toBeInTheDocument();
    expect(latest).toBeNull(); // nothing was sent
  });

  it("omits customFields entirely when the workspace declares none", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateCasesDialog open onOpenChange={() => {}}
        datasetUrn="wr:t:dataset:dataset/ds-1" rows={ROWS} />,
    );
    await user.click(screen.getByRole("button", { name: /Create 2 cases/ }));
    await waitFor(() => expect(latest).not.toBeNull());
    expect(latest.input.customFields).toBeUndefined();
  });
});
