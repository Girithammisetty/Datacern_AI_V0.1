import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils";

let latest: any = null;
/** What the drafting mutation returns, and what it was asked. */
let draftVars: any = null;
let draftReply: any = { fields: [], unfilled: [], model: null, evidenceUsed: [] };
let draftError: Error | null = null;
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
      if (doc.includes("mutation DraftCaseFields")) {
        draftVars = vars;
        return draftError ? Promise.reject(draftError) : Promise.resolve({ draftCaseFields: draftReply });
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
  draftVars = null;
  draftError = null;
  draftReply = { fields: [], unfilled: [], model: null, evidenceUsed: [] };
});

const AI_FIELDS = [
  { name: "siu_referral", dataType: "enum", required: true, readonly: false,
    custom: true, queryScoped: false,
    fieldMeta: { label: "SIU referral", options: ["yes", "no"] } },
  { name: "exposure", dataType: "integer", required: false, readonly: false,
    custom: true, queryScoped: false, fieldMeta: { label: "Exposure" } },
];

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

  // ---- slice 3: AI autofill (suggests; never submits) ----------------------

  it("fills drafted values into the form, marks them AI, and submits nothing on its own", async () => {
    customFields = AI_FIELDS;
    draftReply = {
      fields: [
        { name: "siu_referral", value: "yes", confidence: 0.82, sourceRef: "adjuster note" },
        { name: "exposure", value: 9000, confidence: null, sourceRef: null },
      ],
      unfilled: [],
      model: "llama3.2",
      evidenceUsed: ["provided text"],
    };
    const user = userEvent.setup();
    renderWithProviders(
      <CreateCasesDialog open onOpenChange={() => {}}
        datasetUrn="wr:t:dataset:dataset/ds-1" rows={ROWS} />,
    );
    await screen.findByLabelText(/SIU referral/);
    await user.click(screen.getByRole("button", { name: "Draft with AI" }));
    await user.click(screen.getByRole("button", { name: "Draft fields" }));

    // The values land in the real widgets — editable, not a read-only preview.
    await waitFor(() =>
      expect((screen.getByLabelText(/SIU referral/) as HTMLSelectElement).value).toBe("yes"),
    );
    expect((screen.getByLabelText(/Exposure/) as HTMLInputElement).value).toBe("9000");
    // ...and they are marked so the human knows what to check.
    expect(screen.getAllByText("AI")).toHaveLength(2);
    // The provenance the model gave is shown, not swallowed.
    expect(screen.getByText(/from adjuster note/)).toBeInTheDocument();
    // Nothing was created — drafting is a suggestion, the human still submits.
    expect(latest).toBeNull();

    // Only the form's own field names were offered to the model.
    expect(draftVars.input.fieldNames).toEqual(["siu_referral", "exposure"]);
    expect(draftVars.input.caseId).toBeUndefined();

    await user.click(screen.getByRole("button", { name: /Create 2 cases/ }));
    await waitFor(() => expect(latest).not.toBeNull());
    expect(latest.input.customFields).toEqual({ siu_referral: "yes", exposure: 9000 });
  });

  it("sends the visible material — the selected row is seeded into the box, not attached invisibly", async () => {
    customFields = AI_FIELDS;
    const user = userEvent.setup();
    renderWithProviders(
      <CreateCasesDialog open onOpenChange={() => {}}
        datasetUrn="wr:t:dataset:dataset/ds-1" rows={ROWS} />,
    );
    await screen.findByLabelText(/SIU referral/);
    await user.click(screen.getByRole("button", { name: "Draft with AI" }));

    const box = screen.getByLabelText("Material to draft from") as HTMLTextAreaElement;
    expect(box.value).toContain("claim_id: CLM-1");
    await user.clear(box);
    await user.type(box, "Vendor resubmitted the same invoice.");
    await user.click(screen.getByRole("button", { name: "Draft fields" }));

    await waitFor(() => expect(draftVars).not.toBeNull());
    // exactly what the user could see in the box
    expect(draftVars.input.evidenceText).toBe("Vendor resubmitted the same invoice.");
  });

  it("drops the AI mark once the human edits the value", async () => {
    customFields = AI_FIELDS;
    draftReply = {
      fields: [{ name: "exposure", value: 9000, confidence: null, sourceRef: null }],
      unfilled: ["siu_referral"],
      model: "llama3.2",
      evidenceUsed: ["provided text"],
    };
    const user = userEvent.setup();
    renderWithProviders(
      <CreateCasesDialog open onOpenChange={() => {}}
        datasetUrn="wr:t:dataset:dataset/ds-1" rows={ROWS} />,
    );
    await screen.findByLabelText(/SIU referral/);
    await user.click(screen.getByRole("button", { name: "Draft with AI" }));
    await user.click(screen.getByRole("button", { name: "Draft fields" }));

    await waitFor(() => expect(screen.getAllByText("AI")).toHaveLength(1));
    // The field the model declined is named back, not silently blank.
    expect(screen.getByText(/Left blank: siu_referral/)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Exposure/), "5");
    await waitFor(() => expect(screen.queryByText("AI")).not.toBeInTheDocument());
  });

  it("surfaces the server's refusal verbatim instead of an empty draft", async () => {
    customFields = AI_FIELDS;
    const { GraphQLRequestError } = await import("@/lib/graphql/client");
    draftError = new GraphQLRequestError([
      {
        message: "AI drafting is not configured on this deployment (AI_GATEWAY_VIRTUAL_KEY unset)",
        extensions: { code: "INTERNAL_ERROR" },
      },
    ]);
    const user = userEvent.setup();
    renderWithProviders(
      <CreateCasesDialog open onOpenChange={() => {}}
        datasetUrn="wr:t:dataset:dataset/ds-1" rows={ROWS} />,
    );
    await screen.findByLabelText(/SIU referral/);
    await user.click(screen.getByRole("button", { name: "Draft with AI" }));
    await user.click(screen.getByRole("button", { name: "Draft fields" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "AI drafting is not configured on this deployment",
    );
  });
});